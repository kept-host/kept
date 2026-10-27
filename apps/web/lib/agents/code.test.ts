/**
 * Agent sign-in by emailed code — E09-agents task 007 (D7, Q3).
 *
 * NO MOCKS: every live case runs against the real Better Auth instance, the
 * real Drizzle adapter and the real dev Neon branch with `0011` applied. Only
 * the inbox is skipped (`KEPT_EMAIL_DELIVERY=off`, set by `test:unit`).
 *
 * A code the request route mints is never read: the verify cases seed a known
 * code through `upsertAgentCode`, as a human reading the mail would supply it.
 *
 * ⚠️ NOTHING HERE PRINTS A CODE OR A KEY. Every assertion on one uses a
 * message that does not interpolate it.
 *
 * SKIPS when `DATABASE_URL` is absent. Run with
 *
 *   KEPT_EMAIL_DELIVERY=off pnpm --filter @kept/web exec tsx --test lib/agents/code.test.ts
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { AGENT_CODE_DIGITS, AGENT_RATE_LIMITS, API_KEYS_PER_ACCOUNT, apiKeyPattern, hashToken } from "@kept/shared";
import { config } from "dotenv";

import { drillIp } from "../testing/drill-ip";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

/** Fill only what is missing — a real value in `.env.local` always wins. */
for (const [name, value] of Object.entries({
  BETTER_AUTH_SECRET: "agent-code-drill-secret-not-used-for-anything-real",
  BETTER_AUTH_URL: "https://localhost:3000",
  GITHUB_CLIENT_ID: "unprovisioned.github.invalid",
  GITHUB_CLIENT_SECRET: "unprovisioned.github.invalid",
  GOOGLE_CLIENT_ID: "unprovisioned.google.invalid",
  GOOGLE_CLIENT_SECRET: "unprovisioned.google.invalid",
  RESEND_API_KEY: "unprovisioned.resend.invalid",
  EMAIL_FROM: "drill@unprovisioned.invalid",
  RATE_LIMIT_SECRET: "e09-007-agent-code-rate-limit-secret-0123456789abcdef",
})) {
  if (!process.env[name]?.trim()) process.env[name] = value;
}

const runId = crypto.randomUUID().slice(0, 8);
const address = (label: string) => `${label}-${runId}@kept-e09-007.invalid`;
const adminEmail = address("admin");

/** This file owns the allowlist for its whole run; the dev value is not read. */
process.env.KEPT_ADMIN_EMAILS = adminEmail;

function setOpen(open: boolean): void {
  if (open) process.env.NEXT_PUBLIC_KEPT_OPEN = "true";
  else delete process.env.NEXT_PUBLIC_KEPT_OPEN;
}

const emails = new Set<string>();
const buckets = new Set<string>();

async function deps() {
  const { eq, inArray, sql } = await import("drizzle-orm");
  const { db, schema } = await import("../db");
  const code = await import("./code");
  const { upsertAgentCode } = await import("../db/queries/agent-codes");
  const { insertApiKey } = await import("../db/queries/api-keys");
  const { keyCallerFrom } = await import("./keys");
  const { emailKey, ipKey } = await import("../rate-limit");
  return { eq, inArray, sql, db, schema, upsertAgentCode, insertApiKey, keyCallerFrom, emailKey, ipKey, ...code };
}

after(async () => {
  if (skipLive) return;
  const { db, schema, inArray, sql } = await deps();
  if (emails.size > 0) {
    // Cascades `profiles` and `api_keys`.
    await db.delete(schema.user).where(inArray(schema.user.email, [...emails]));
    await db.delete(schema.agentCodes).where(inArray(schema.agentCodes.email, [...emails]));
  }
  for (const bucket of buckets) {
    await db.execute(sql`delete from rate_limits where bucket = ${bucket}`);
  }
  await db.$client.end();
});

/** `requestAgentCode` from a fresh drill IP, tracking both buckets it counts. */
async function request(email: string, ip = drillIp()) {
  const { emailKey, ipKey, requestAgentCode } = await deps();
  emails.add(email);
  buckets.add(await ipKey("agent-code", ip));
  buckets.add(await emailKey("agent-code", email));
  return requestAgentCode({ email }, ip, "codex/skill");
}

async function storedHash(email: string): Promise<string | null> {
  const { db, schema, eq } = await deps();
  const [row] = await db
    .select({ codeHash: schema.agentCodes.codeHash })
    .from(schema.agentCodes)
    .where(eq(schema.agentCodes.email, email));
  return row?.codeHash ?? null;
}

/** Seed `code` for `email`, as the request route would have. */
async function seed(email: string, code: string): Promise<void> {
  const { upsertAgentCode } = await deps();
  emails.add(email);
  await upsertAgentCode(email, await hashToken(code), "codex/skill");
}

async function verify(email: string, code: string, keyName = "codex on laptop") {
  const { verifyAgentCode } = await deps();
  return verifyAgentCode({ email, code, keyName });
}

async function userRow(email: string) {
  const { db, schema, eq } = await deps();
  const [row] = await db.select().from(schema.user).where(eq(schema.user.email, email));
  return row ?? null;
}

const INVALID_CODE = { error: "invalid_code" };

test("codes are AGENT_CODE_DIGITS decimal digits, zero-padded", async () => {
  const { generateAgentCode } = await import("./code");
  for (let i = 0; i < 200; i += 1) {
    assert.match(generateAgentCode(), new RegExp(`^\\d{${AGENT_CODE_DIGITS}}$`));
  }
});

test(
  "request: one 202 for a new address, an existing account, a closed non-admin and an address over its limit",
  { skip: skipLive },
  async () => {
    setOpen(true);
    const fresh = await request(address("fresh"));
    assert.ok(await storedHash(address("fresh")), "a new address gets a code");

    const existing = address("existing");
    await seed(existing, "000000");
    assert.equal((await verify(existing, "000000")).ok, true, "fixture: the account exists");
    const known = await request(existing);
    assert.ok(await storedHash(existing), "an existing account gets a code");

    setOpen(false);
    const stranger = await request(address("stranger"));
    assert.equal(await storedHash(address("stranger")), null, "closed: no code for a non-admin");

    setOpen(true);
    const capped = address("capped");
    const outcomes = [];
    for (let i = 0; i < AGENT_RATE_LIMITS.agentCodePerEmail.limit; i += 1) outcomes.push(await request(capped));
    const before = await storedHash(capped);
    const over = await request(capped);
    assert.equal(await storedHash(capped), before, "over the per-address limit, no new code");

    for (const outcome of [fresh, known, stranger, ...outcomes, over]) {
      assert.deepEqual(outcome, { ok: true, status: 202, body: { ok: true } });
    }
  },
);

test("request: the per-IP limit answers 429 with retry_after_seconds", { skip: skipLive }, async () => {
  setOpen(false);
  const ip = drillIp();
  const statuses: number[] = [];
  let last;
  for (let i = 0; i <= AGENT_RATE_LIMITS.agentCodePerIp.limit; i += 1) {
    last = await request(address(`ip-${i}`), ip);
    statuses.push(last.status);
  }
  assert.deepEqual(statuses, [202, 202, 202, 202, 202, 429]);
  assert.equal(last!.ok, false);
  if (!last!.ok) {
    assert.equal(last!.body.error, "rate_limited");
    assert.ok((last!.body.retry_after_seconds ?? 0) >= 1);
  }
});

test(
  "verify: a first code creates the account through Better Auth — verified, with its profile — and a working key",
  { skip: skipLive },
  async () => {
    setOpen(true);
    const { db, schema, eq, keyCallerFrom } = await deps();
    const email = address("new");
    await seed(email, "482913");

    const outcome = await verify(email, "482913");
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.status, 200);
    assert.ok(apiKeyPattern.test(outcome.body.api_key), "a well-formed key");
    assert.equal(outcome.body.key_name, "codex on laptop");

    const user = await userRow(email);
    assert.ok(user, "the user row exists");
    assert.equal(user.emailVerified, true);
    const [profile] = await db.select().from(schema.profiles).where(eq(schema.profiles.id, user.id));
    assert.ok(profile, "bootstrapProfile ran (the create.after hook)");

    const caller = await keyCallerFrom(
      new Request("https://localhost:3000/api/v1/pages", { headers: { authorization: `Bearer ${outcome.body.api_key}` } }),
    );
    assert.equal(caller?.profileId, user.id, "the key speaks for the new account");
    assert.equal(await storedHash(email), null, "success deletes the code");

    assert.deepEqual((await verify(email, "482913")).ok ? "accepted" : "refused", "refused", "single use");

    // A second code for the same address mints a second key on the SAME account.
    await seed(email, "111222");
    const again = await verify(email, "111222", "second");
    assert.equal(again.ok, true);
    const { count } = await import("drizzle-orm");
    const [users] = await db.select({ n: count() }).from(schema.user).where(eq(schema.user.email, email));
    assert.equal(users?.n, 1, "no second account");
  },
);

test("verify: five wrong tries kill the code even when the sixth is right", { skip: skipLive }, async () => {
  setOpen(true);
  const email = address("locked");
  await seed(email, "135790");
  for (let i = 0; i < 5; i += 1) {
    const wrong = await verify(email, "000001");
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.deepEqual({ error: wrong.body.error }, INVALID_CODE);
  }
  const right = await verify(email, "135790");
  assert.equal(right.ok, false, "the right code after five wrong ones is refused");
  if (!right.ok) {
    assert.equal(right.status, 400);
    assert.deepEqual({ error: right.body.error }, INVALID_CODE);
  }
  assert.equal(await userRow(email), null, "no account");
});

test("verify: expired, unknown and wrong all answer the same 400 invalid_code", { skip: skipLive }, async () => {
  setOpen(true);
  const { db, schema, eq, sql } = await deps();
  const expired = address("expired");
  await seed(expired, "246810");
  await db
    .update(schema.agentCodes)
    .set({ expiresAt: sql`now() - interval '1 second'` })
    .where(eq(schema.agentCodes.email, expired));

  const wrongEmail = address("wrong");
  await seed(wrongEmail, "999999");

  const failures = [
    await verify(expired, "246810"),
    await verify(address("unknown"), "123456"),
    await verify(wrongEmail, "999998"),
  ];
  const [first, ...rest] = failures;
  assert.equal(first!.ok, false);
  if (!first!.ok) {
    assert.equal(first!.status, 400);
    assert.equal(first!.body.error, "invalid_code");
  }
  for (const failure of rest) assert.deepEqual(failure, first, "one shape for every failure");
  assert.equal(await userRow(expired), null);
});

test(
  "verify, closed: a non-admin's code (minted before the deploy closed) is refused and makes no account; an admin's works",
  { skip: skipLive },
  async () => {
    setOpen(false);
    const stranger = address("closed-stranger");
    await seed(stranger, "314159");
    const refused = await verify(stranger, "314159");
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.body.error, "invalid_code");
    assert.equal(await userRow(stranger), null, "no account for a non-admin");

    await seed(adminEmail, "271828");
    const admitted = await verify(adminEmail, "271828");
    assert.equal(admitted.ok, true, "an admin gets a key while closed");
    assert.ok(await userRow(adminEmail));
  },
);

test(`verify: at ${API_KEYS_PER_ACCOUNT} keys the answer is 409 key_limit_reached`, { skip: skipLive }, async () => {
  setOpen(true);
  const { insertApiKey } = await deps();
  const email = address("full");
  await seed(email, "100001");
  assert.equal((await verify(email, "100001")).ok, true);
  const user = await userRow(email);
  for (let i = 1; i < API_KEYS_PER_ACCOUNT; i += 1) {
    const row = await insertApiKey(user!.id, {
      name: `fill ${i}`,
      prefix: "kpt_live_fill",
      hash: await hashToken(`${runId}-fill-${i}`),
    });
    assert.ok(row, `key ${i + 1} fits`);
  }
  await seed(email, "100002");
  const full = await verify(email, "100002");
  assert.equal(full.ok, false);
  if (!full.ok) {
    assert.equal(full.status, 409);
    assert.equal(full.body.error, "key_limit_reached");
  }
});
