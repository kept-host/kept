import { apiKeyPattern, hashToken } from "@kept/shared";
import { expect, test, type APIResponse } from "@playwright/test";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";

import { keyCallerFrom } from "../lib/agents/keys";
import { closeDb, db, schema } from "../lib/db";
import { upsertAgentCode } from "../lib/db/queries/agent-codes";
import { keptOpen } from "../lib/launch";
import { emailKey, ipKey } from "../lib/rate-limit";
import { drillIp } from "../lib/testing/drill-ip";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { servingDomain } from "./live-publish";

/**
 * Agent sign-in by emailed code over HTTP, on an OPEN deploy — E09 task 007
 * (D7). `lib/agents/code.test.ts` proves the rules; this file proves the
 * routes: one 202 whatever the address, one 400 `invalid_code` whatever the
 * failure, a key once, never a cookie, and no origin gate (an agent calls
 * these from a terminal, and a hosted page's `Origin` changes nothing).
 *
 * The code the request route mails is never read: verify cases seed a known
 * code through `upsertAgentCode`, as the human reading the mail would supply it.
 *
 * 0 publishes, 0 KV writes. ⚠️ No code or key is printed: assertions on one
 * carry a message that does not interpolate it.
 *
 * SKIPS without `DATABASE_URL`, and on a closed harness (`agents.closed.spec.ts`
 * covers closed mode).
 */

config({ path: ".env.local", quiet: true });

const runId = crypto.randomUUID().slice(0, 8);
const address = (label: string) => `${label}-${runId}@kept-e09-007-e2e.invalid`;

const emails = new Set<string>();
const buckets = new Set<string>();

async function requestCode(
  request: import("@playwright/test").APIRequestContext,
  email: string,
  ip = drillIp(),
  headers: Record<string, string> = {},
): Promise<APIResponse> {
  emails.add(email);
  buckets.add(await ipKey("agent-code", ip));
  buckets.add(await emailKey("agent-code", email));
  return request.post("/api/agent/request-code", {
    data: { email },
    headers: { "cf-connecting-ip": ip, "x-kept-client": "codex/skill", ...headers },
  });
}

async function seed(email: string, code: string): Promise<void> {
  emails.add(email);
  await upsertAgentCode(email, await hashToken(code), "codex/skill");
}

function expectNoCookie(response: APIResponse): void {
  expect(response.headers()["set-cookie"], response.url()).toBeUndefined();
}

test.describe("agent sign-in by emailed code (open)", () => {
  test.skip(!keptOpen(), "the harness is closed — agents.closed.spec.ts covers closed mode");
  test.skip(!process.env.DATABASE_URL, "DATABASE_URL absent — run locally with apps/web/.env.local");
  test.describe.configure({ mode: "serial", timeout: LIVE_STACK_TIMEOUT });

  test.beforeAll(async () => {
    await warmDb();
  });

  test.afterAll(async () => {
    if (emails.size > 0) {
      // Cascades `profiles` and `api_keys`.
      await db.delete(schema.user).where(inArray(schema.user.email, [...emails]));
      await db.delete(schema.agentCodes).where(inArray(schema.agentCodes.email, [...emails]));
    }
    if (buckets.size > 0) await db.delete(schema.rateLimits).where(inArray(schema.rateLimits.bucket, [...buckets]));
    await closeDb();
  });

  test("request-code: the same 202 for a new address and an existing account, no cookie, a hosted page's Origin changes nothing", async ({
    request,
  }) => {
    const existing = address("existing");
    await seed(existing, "520520");
    const created = await request.post("/api/agent/verify-code", {
      data: { email: existing, code: "520520", keyName: "fixture" },
    });
    expect(created.status(), "fixture: the account exists").toBe(200);

    const responses = [
      await requestCode(request, address("fresh")),
      await requestCode(request, existing),
      await requestCode(request, address("hosted"), drillIp(), { origin: `https://somepage.${servingDomain()}` }),
    ];
    for (const response of responses) {
      expect(response.status()).toBe(202);
      expect(await response.json()).toEqual({ ok: true });
      expectNoCookie(response);
    }

    const rows = await db
      .select({ email: schema.agentCodes.email, client: schema.agentCodes.client })
      .from(schema.agentCodes)
      .where(inArray(schema.agentCodes.email, [address("fresh"), existing, address("hosted")]));
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.client === "codex/skill"), "X-Kept-Client stored").toBe(true);
  });

  test("request-code: a bad body is 400 invalid_request; the 6th from one IP in an hour is 429 with Retry-After", async ({
    request,
  }) => {
    const bad = await request.post("/api/agent/request-code", { data: { email: "not-an-address" } });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error).toBe("invalid_request");

    const ip = drillIp();
    const statuses: number[] = [];
    let last: APIResponse | undefined;
    for (let i = 0; i < 6; i += 1) {
      last = await requestCode(request, address(`ip-${i}`), ip);
      statuses.push(last.status());
    }
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
    const body = await last!.json();
    expect(body.error).toBe("rate_limited");
    expect(Number(last!.headers()["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  test("verify-code: the key once, no cookie; wrong, unknown and spent codes are one 400 invalid_code", async ({
    request,
  }) => {
    const email = address("verify");
    await seed(email, "908172");

    const wrong = await request.post("/api/agent/verify-code", {
      data: { email, code: "908173", keyName: "claude-code" },
    });
    const unknown = await request.post("/api/agent/verify-code", {
      data: { email: address("nobody"), code: "908172", keyName: "claude-code" },
    });
    for (const failure of [wrong, unknown]) {
      expect(failure.status()).toBe(400);
      expectNoCookie(failure);
    }
    const wrongBody = await wrong.json();
    expect(wrongBody.error).toBe("invalid_code");
    expect(await unknown.json()).toEqual(wrongBody);

    const ok = await request.post("/api/agent/verify-code", {
      data: { email, code: "908172", keyName: "claude-code" },
      headers: { origin: `https://somepage.${servingDomain()}` },
    });
    expect(ok.status()).toBe(200);
    expectNoCookie(ok);
    expect(ok.headers()["cache-control"]).toBe("no-store");
    const body = (await ok.json()) as { api_key: string; key_name: string };
    expect(Object.keys(body).sort()).toEqual(["api_key", "key_name"]);
    expect(body.key_name).toBe("claude-code");
    expect(apiKeyPattern.test(body.api_key), "a well-formed key").toBe(true);

    const [user] = await db.select().from(schema.user).where(eq(schema.user.email, email));
    expect(user?.emailVerified).toBe(true);
    const caller = await keyCallerFrom(
      new Request("https://localhost:3000/api/v1/pages", { headers: { authorization: `Bearer ${body.api_key}` } }),
    );
    expect(caller?.profileId, "the key speaks for the new account").toBe(user?.id);

    const spent = await request.post("/api/agent/verify-code", {
      data: { email, code: "908172", keyName: "claude-code" },
    });
    expect(spent.status()).toBe(400);
    expect(await spent.json()).toEqual(wrongBody);
  });
});
