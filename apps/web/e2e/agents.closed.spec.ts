import { apiKeyPattern, hashToken, keyedPublishResponseSchema } from "@kept/shared";
import { expect, test } from "@playwright/test";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";

import { createKey } from "../lib/agents/keys";
import { closeDb, db, schema } from "../lib/db";
import { upsertAgentCode } from "../lib/db/queries/agent-codes";
import { keptOpen } from "../lib/launch";
import { emailKey, ipKey } from "../lib/rate-limit";
import { waitlistHref } from "../lib/routing/host-split";
import { drillIp } from "../lib/testing/drill-ip";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { cleanup, newScope, titledHtml } from "./owner-fixtures";

/**
 * E09's ONE closed-mode spec — the agent doors on the deploy prod runs until
 * launch. Run with `pnpm --filter @kept/web test:e2e:closed`.
 *
 *   - `/api/agent/request-code` for a non-admin: the same 202, no code stored,
 *     no mail (task 007).
 *   - for the run's agent admin: a code stored; verify (with a seeded code)
 *     mints a key and creates the account through Better Auth (task 007).
 *   - `/api/v1/pages` with no credential: the middleware's `not_open` 404.
 *   - `/api/v1/pages` with a non-admin's key: the handler's `not_open` 404;
 *     with the admin's key: the page publishes (task 008, the `key` door).
 *
 *   - `/mcp` (task 009): with no credential, `initialize` is a JSON-RPC error
 *     carrying `not_open` and a lone notification the 404 itself; an access
 *     token gets the keyless tool set, the admin's key the keyed set.
 *
 * 1 publish, 1 KV write (plus its teardown); the `/mcp` cases publish nothing. ⚠️ No code or key is printed.
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
/** The admin's keyed page and the non-admin's account, collected in `afterAll`. */
const scope = newScope();

async function requestCode(request: import("@playwright/test").APIRequestContext, email: string) {
  const ip = drillIp();
  buckets.add(await ipKey("agent-code", ip));
  buckets.add(await emailKey("agent-code", email));
  return request.post("/api/agent/request-code", { data: { email }, headers: { "cf-connecting-ip": ip } });
}

const MCP_HEADERS = { accept: "application/json, text/event-stream", "content-type": "application/json" };
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "closed-drill", version: "1" } },
};

/** `initialize` then `tools/list` on the session it minted: the tool names this caller sees. */
async function mcpToolNames(request: import("@playwright/test").APIRequestContext, authorization: string): Promise<string[]> {
  const headers = { ...MCP_HEADERS, authorization };
  const initialized = await request.post("/mcp", { headers, data: INITIALIZE });
  expect(initialized.status(), await initialized.text()).toBe(200);
  const session = initialized.headers()["mcp-session-id"];
  expect(session, "initialize minted a session").toBeTruthy();
  const listed = await request.post("/mcp", {
    headers: { ...headers, "mcp-session-id": session! },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  expect(listed.status()).toBe(200);
  const body = (await listed.json()) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((tool) => tool.name).sort();
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
    const owners = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, ADMIN));
    scope.userIds.push(...owners.map((owner) => owner.id));
    await cleanup(scope);
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

  test("/api/v1/pages: a non-admin's key is not_open; the admin's key publishes", async ({ request }) => {
    const strangerId = crypto.randomUUID();
    await db.insert(schema.user).values({ id: strangerId, name: "E09 closed stranger", email: `key-${STRANGER}`, emailVerified: true });
    await db.insert(schema.profiles).values({ id: strangerId, email: `key-${STRANGER}` });
    scope.userIds.push(strangerId);
    const strangerKey = await createKey(strangerId, "closed stranger");
    expect(strangerKey, "a key was minted").not.toBeNull();
    const refused = await request.post("/api/v1/pages", {
      headers: { authorization: `Bearer ${strangerKey!.apiKey}` },
      data: { html: titledHtml("closed stranger") },
    });
    expect(refused.status()).toBe(404);
    expect(await refused.json()).toEqual(NOT_OPEN);

    const [admin] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, ADMIN));
    expect(admin, "the previous test made the admin's account").toBeTruthy();
    const adminKey = await createKey(admin!.id, "closed admin");
    expect(adminKey, "a key was minted").not.toBeNull();
    buckets.add(`key:${adminKey!.summary.id}`);
    const published = await request.post("/api/v1/pages", {
      headers: { authorization: `Bearer ${adminKey!.apiKey}` },
      data: { html: titledHtml("closed admin keyed page") },
    });
    expect(published.status(), await published.text()).toBe(201);
    const body = keyedPublishResponseSchema.parse(await published.json());
    scope.slugs.add(body.slug);
    expect(body.kept).toBe(true);
  });

  test("/mcp without a credential: initialize is a JSON-RPC not_open; a lone notification the 404", async ({ request }) => {
    const refused = await request.post("/mcp", { headers: MCP_HEADERS, data: INITIALIZE });
    expect(refused.status()).toBe(200);
    expect(refused.headers()["mcp-session-id"], "no session is minted").toBeUndefined();
    const body = (await refused.json()) as { id: number; error: { code: number; message: string; data: unknown } };
    expect(body.id).toBe(0);
    expect(body.error.message).toBe(NOT_OPEN.message);
    expect(body.error.data).toEqual(NOT_OPEN);

    const notification = await request.post("/mcp", {
      headers: MCP_HEADERS,
      data: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    expect(notification.status()).toBe(404);
    expect(await notification.json()).toEqual(NOT_OPEN);
  });

  test("/mcp: an access token gets the keyless set; the admin's key the keyed set", async ({ request }) => {
    const token = process.env.KEPT_E2E_ACCESS_TOKEN;
    expect(token, "playwright.config.ts mints KEPT_E2E_ACCESS_TOKEN for a closed run").toBeTruthy();
    expect(await mcpToolNames(request, `Bearer ${token}`)).toEqual(["delete_page", "get_page", "publish_page", "replace_page"]);

    const [admin] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, ADMIN));
    expect(admin, "an earlier test made the admin's account").toBeTruthy();
    const adminKey = await createKey(admin!.id, "closed mcp admin");
    expect(adminKey, "a key was minted").not.toBeNull();
    expect(await mcpToolNames(request, `Bearer ${adminKey!.apiKey}`)).toEqual([
      "delete_page",
      "get_page",
      "list_pages",
      "publish_page",
      "replace_page",
    ]);
  });
});
