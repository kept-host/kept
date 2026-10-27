/**
 * The API-key lifecycle — E09-agents task 006 (D6, AC7, AC9).
 *
 * NO MOCKS: every case runs against the real dev Neon branch with `0011`
 * applied. Shown once, hash only, the 26th refused, revocation immediate,
 * `last_used_on` written at most once a day, and only a Bearer key counts.
 *
 * ⚠️ NOTHING HERE PRINTS A KEY. Every assertion on a raw key uses a message
 * that does not interpolate it, so a failure cannot leak one into a log.
 *
 * SKIPS when `DATABASE_URL` is absent. Run with
 *
 *   pnpm --filter @kept/web exec tsx --test lib/agents/keys.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";

import {
  API_KEY_DISPLAY_PREFIX_CHARS,
  API_KEYS_PER_ACCOUNT,
  AGENT_RATE_LIMITS,
  apiKeyPattern,
} from "@kept/shared";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const createdUsers = new Set<string>();
const buckets = new Set<string>();

async function deps() {
  const { eq, inArray, sql } = await import("drizzle-orm");
  const { closeDb, db } = await import("../db");
  const { apiKeys, profiles, user } = await import("../db/schema");
  const keys = await import("./keys");
  return { eq, inArray, sql, closeDb, db, apiKeys, profiles, user, ...keys };
}

after(async () => {
  if (skipLive) return;
  const { closeDb, db, inArray, sql, user } = await deps();
  if (createdUsers.size > 0) {
    // Cascades `profiles` and `api_keys`.
    await db.delete(user).where(inArray(user.id, [...createdUsers]));
  }
  for (const bucket of buckets) {
    await db.execute(sql`delete from rate_limits where bucket = ${bucket}`);
  }
  await closeDb();
});

async function makeUser(): Promise<string> {
  const { db, profiles, user } = await deps();
  const id = crypto.randomUUID();
  const email = `e09-006-${id}@kept.invalid`;
  await db.insert(user).values({ id, name: "E09-006 drill", email, emailVerified: true });
  await db.insert(profiles).values({ id, email });
  createdUsers.add(id);
  return id;
}

function bearer(credential: string, scheme = "Bearer"): Request {
  return new Request("https://localhost:3000/api/v1/pages", {
    headers: { authorization: `${scheme} ${credential}` },
  });
}

/** The row's `xmin`: it changes on every write, so equal means "not written". */
async function rowVersion(keyId: string): Promise<string> {
  const { db, sql } = await deps();
  const rows = await db.execute<{ v: string }>(
    sql`select xmin::text as v from api_keys where id = ${keyId}`,
  );
  return rows[0]!.v;
}

test("a created key is shown once, stored only as its SHA-256, and listed without it", { skip: skipLive }, async () => {
  const { apiKeys, createKey, db, eq, listKeys } = await deps();
  const profileId = await makeUser();

  const created = await createKey(profileId, "  Laptop  ");
  assert.ok(created, "the first key is created");
  assert.ok(apiKeyPattern.test(created.apiKey), "the raw key is kpt_live_ + 43 base64url chars");
  assert.equal(created.summary.name, "Laptop", "the name is trimmed");
  assert.equal(created.summary.prefix, created.apiKey.slice(0, API_KEY_DISPLAY_PREFIX_CHARS));
  assert.equal(created.summary.last_used_on, null);
  assert.equal("api_key" in created.summary, false, "the summary never carries the key");

  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.summary.id));
  assert.ok(row);
  assert.equal(
    row.hash === createHash("sha256").update(created.apiKey).digest("hex"),
    true,
    "the stored hash is the key's SHA-256 hex",
  );
  assert.equal(
    Object.values(row).some((value) => value === created.apiKey),
    false,
    "no column holds the raw key",
  );

  const listed = await listKeys(profileId);
  assert.deepEqual(listed, [created.summary]);
  assert.equal(JSON.stringify(listed).includes(row.hash), false, "the list never carries the hash");
});

test(`AC9: the ${API_KEYS_PER_ACCOUNT + 1}th key is refused; a revoke frees a slot`, { skip: skipLive }, async () => {
  const { createKey, listKeys, revokeKey } = await deps();
  const profileId = await makeUser();
  for (let i = 0; i < API_KEYS_PER_ACCOUNT; i++) {
    assert.ok(await createKey(profileId, `key ${i}`), `key ${i} is created`);
  }
  assert.equal(await createKey(profileId, "one too many"), null);

  const [newest] = await listKeys(profileId);
  assert.equal(await revokeKey(profileId, newest!.id), true);
  assert.ok(await createKey(profileId, "after a revoke"), "a revoke frees a slot");
});

test("keyCallerFrom: only Authorization: Bearer kpt_live_… counts, and never a cookie (AC7)", { skip: skipLive }, async () => {
  const { createKey, keyCallerFrom } = await deps();
  const profileId = await makeUser();
  const created = (await createKey(profileId, "caller"))!;

  const caller = await keyCallerFrom(bearer(created.apiKey));
  assert.deepEqual(caller, { keyId: created.summary.id, profileId, plan: "free" });
  assert.deepEqual(await keyCallerFrom(bearer(created.apiKey, "bearer")), caller);

  const cookieOnly = new Request("https://localhost:3000/api/v1/pages", {
    headers: { cookie: `__Host-kept.session_token=${created.apiKey}` },
  });
  for (const request of [
    cookieOnly,
    new Request("https://localhost:3000/api/v1/pages"),
    bearer(created.apiKey, "Basic"),
    bearer(`${created.apiKey}x`),
    bearer(created.apiKey.slice("kpt_live_".length)),
    bearer(created.apiKey.replace("kpt_live_", "kpt_access_")),
    bearer(`kpt_live_${"A".repeat(43)}`),
  ]) {
    assert.equal(await keyCallerFrom(request), null, "refused shape");
  }
});

test("last_used_on is stamped today, written at most once a day", { skip: skipLive }, async () => {
  const { apiKeys, createKey, db, eq, keyCallerFrom, listKeys, sql } = await deps();
  const profileId = await makeUser();
  const created = (await createKey(profileId, "daily"))!;

  await keyCallerFrom(bearer(created.apiKey));
  const today = (await db.execute<{ today: string }>(sql`select current_date::text as today`))[0]!.today;
  assert.equal((await listKeys(profileId))[0]!.last_used_on, today);

  const stamped = await rowVersion(created.summary.id);
  await keyCallerFrom(bearer(created.apiKey));
  await keyCallerFrom(bearer(created.apiKey));
  assert.equal(await rowVersion(created.summary.id), stamped, "a second use the same day writes nothing");

  // Yesterday's stamp is refreshed by today's first use.
  await db
    .update(apiKeys)
    .set({ lastUsedOn: sql`current_date - 1` })
    .where(eq(apiKeys.id, created.summary.id));
  await keyCallerFrom(bearer(created.apiKey));
  assert.equal((await listKeys(profileId))[0]!.last_used_on, today);
});

test("revocation is immediate, owner-scoped, and a malformed id is a plain no", { skip: skipLive }, async () => {
  const { createKey, keyCallerFrom, listKeys, revokeKey } = await deps();
  const owner = await makeUser();
  const stranger = await makeUser();
  const created = (await createKey(owner, "to revoke"))!;
  assert.ok(await keyCallerFrom(bearer(created.apiKey)));

  assert.equal(await revokeKey(stranger, created.summary.id), false, "another account's key");
  assert.equal(await revokeKey(owner, "not-a-uuid"), false);
  assert.equal(await revokeKey(owner, crypto.randomUUID()), false);
  assert.ok(await keyCallerFrom(bearer(created.apiKey)), "a stranger's revoke changed nothing");

  assert.equal(await revokeKey(owner, created.summary.id), true);
  assert.equal(await keyCallerFrom(bearer(created.apiKey)), null, "refused on the very next use");
  assert.deepEqual(await listKeys(owner), []);
  assert.equal(await revokeKey(owner, created.summary.id), true, "revoking twice is idempotent");
});

test("checkKeyLimit counts on the key's own hourly bucket", { skip: skipLive }, async () => {
  const { checkKeyLimit, db, sql } = await deps();
  const keyId = crypto.randomUUID();
  buckets.add(`key:${keyId}`);

  assert.deepEqual(await checkKeyLimit(keyId), { allowed: true });
  await db.execute(
    sql`update rate_limits set count = ${AGENT_RATE_LIMITS.perKeyHour.limit} where bucket = ${`key:${keyId}`}`,
  );
  const over = await checkKeyLimit(keyId);
  assert.equal(over.allowed, false, `the ${AGENT_RATE_LIMITS.perKeyHour.limit + 1}st hit in the hour is refused`);
  assert.ok(!over.allowed && over.retryAfterSeconds > 0);
});
