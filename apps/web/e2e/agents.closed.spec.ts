import { apiKeyPattern, hashToken } from "@kept/shared";
import { expect, test } from "@playwright/test";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { upsertAgentCode } from "../lib/db/queries/agent-codes";
import { keptOpen } from "../lib/launch";
import { emailKey, ipKey } from "../lib/rate-limit";
import { waitlistHref } from "../lib/routing/host-split";
import { drillIp } from "../lib/testing/drill-ip";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";

/**
 * E09's ONE closed-mode spec — the agent doors on the deploy prod runs until
 * launch. Run with `pnpm --filter @kept/web test:e2e:closed`.
 *
 *   - `/api/agent/request-code` for a non-admin: the same 202, no code stored,
 *     no mail (task 007).
 *   - for the run's agent admin: a code stored; verify (with a seeded code)
 *     mints a key and creates the account through Better Auth (task 007).
 *   - `/api/v1/pages` with no credential: the middleware's `not_open` 404, so
 *     it holds before task 008's handlers exist.
 *
 * Task 008 adds its admin-key case and task 009 its `/mcp` cases here.
 *
 * 0 publishes, 0 KV writes. ⚠️ No code or key is printed.
 */

config({ path: ".env.local", quiet: true });

const ADMIN = process.env.KEPT_E2E_AGENT_ADMIN_EMAIL!;
const STRANGER = `e09-closed-stranger-${crypto.randomUUID().slice(0, 8)}@kept-e09.invalid`;

const NOT_OPEN = {
  error: "not_open",
  message: "kept opens in December.",
  waitlist: waitlistHref(process.env.NEXT_PUBLIC_APP_URL),
};

const buckets = new Set<string>();

async function requestCode(request: import("@playwright/test").APIRequestContext, email: string) {
  const ip = drillIp();
  buckets.add(await ipKey("agent-code", ip));
  buckets.add(await emailKey("agent-code", email));
  return request.post("/api/agent/request-code", { data: { email }, headers: { "cf-connecting-ip": ip } });
}

async function codeRows(email: string): Promise<number> {
  const rows = await db.select().from(schema.agentCodes).where(eq(schema.agentCodes.email, email));
  return rows.length;
}

test.describe("the agent doors (closed)", () => {
  test.skip(keptOpen(), "the harness is open — run `pnpm test:e2e:closed` for this file");
  test.skip(!process.env.DATABASE_URL, "DATABASE_URL absent — run locally with apps/web/.env.local");
  test.describe.configure({ mode: "serial", timeout: LIVE_STACK_TIMEOUT });

  test.beforeAll(async ({ request }) => {
    const health = await request.get("/api/health");
    expect(((await health.json()) as { open: boolean }).open, "the server on :3000 is open").toBe(false);
    await warmDb();
  });

  test.afterAll(async () => {
    // Cascades `profiles` and `api_keys`.
    await db.delete(schema.user).where(inArray(schema.user.email, [ADMIN, STRANGER]));
    await db.delete(schema.agentCodes).where(inArray(schema.agentCodes.email, [ADMIN, STRANGER]));
    if (buckets.size > 0) await db.delete(schema.rateLimits).where(inArray(schema.rateLimits.bucket, [...buckets]));
    await closeDb();
  });

  test("request-code for a non-admin: the same 202, no code stored", async ({ request }) => {
    const response = await requestCode(request, STRANGER);
    expect(response.status()).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers()["set-cookie"]).toBeUndefined();
    expect(await codeRows(STRANGER)).toBe(0);
  });

  test("request-code for an admin stores a code; verify mints a key and makes the account", async ({ request }) => {
    expect(ADMIN, "playwright.config.ts sets KEPT_E2E_AGENT_ADMIN_EMAIL").toBeTruthy();
    const response = await requestCode(request, ADMIN);
    expect(response.status()).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(await codeRows(ADMIN)).toBe(1);

    // The mailed code is never read: a known one replaces it, as the human would supply it.
    await upsertAgentCode(ADMIN, await hashToken("424242"), null);
    const verified = await request.post("/api/agent/verify-code", {
      data: { email: ADMIN, code: "424242", keyName: "closed drill" },
    });
    expect(verified.status()).toBe(200);
    expect(verified.headers()["set-cookie"]).toBeUndefined();
    const body = (await verified.json()) as { api_key: string; key_name: string };
    expect(apiKeyPattern.test(body.api_key), "a well-formed key").toBe(true);
    expect(body.key_name).toBe("closed drill");

    const [user] = await db.select().from(schema.user).where(eq(schema.user.email, ADMIN));
    expect(user?.emailVerified).toBe(true);
    const [profile] = await db.select().from(schema.profiles).where(eq(schema.profiles.id, user!.id));
    expect(profile, "bootstrapProfile ran").toBeTruthy();
  });

  test("/api/v1/pages without a credential is the middleware's not_open 404", async ({ request }) => {
    for (const response of [await request.get("/api/v1/pages"), await request.post("/api/v1/pages", { data: {} })]) {
      expect(response.status(), response.url()).toBe(404);
      expect(await response.json()).toEqual(NOT_OPEN);
    }
  });
});
