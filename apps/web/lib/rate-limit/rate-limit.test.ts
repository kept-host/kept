/**
 * `lib/rate-limit` (E06a task 001, AC16 limiter half).
 *
 * NO MOCKS: `hit` and `pruneBuckets` run against the real dev Neon branch with
 * migration `0007` applied, and SKIP when `DATABASE_URL` is absent (CI on fork
 * PRs). The key builders need no database and run everywhere.
 *
 * `RATE_LIMIT_SECRET` is set to a fixed test value: the salt assertions need a
 * known key, and the buckets written here are deleted in `after`.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { RATE_LIMITS, hashToken } from "@kept/shared";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
process.env.RATE_LIMIT_SECRET = "e06a-001-rate-limit-test-secret-0123456789abcdef";

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const buckets = new Set<string>();

function drillBucket(): string {
  const bucket = `e06a-001-drill:${crypto.randomUUID()}`;
  buckets.add(bucket);
  return bucket;
}

after(async () => {
  if (skipLive) return;
  const { db, closeDb } = await import("../db");
  const { rateLimits } = await import("../db/schema");
  const { inArray } = await import("drizzle-orm");
  if (buckets.size > 0) await db.delete(rateLimits).where(inArray(rateLimits.bucket, [...buckets]));
  await closeDb();
});

test("ipKey is route-prefixed, hides the address, and its salt changes with the UTC day", async () => {
  const { ipKey } = await import("./index");
  const ip = "203.0.113.7";
  const morning = new Date("2026-10-11T00:00:01Z");
  const evening = new Date("2026-10-11T23:59:59Z");
  const nextDay = new Date("2026-10-12T00:00:01Z");

  const today = await ipKey("waitlist", ip, morning);
  assert.match(today, /^waitlist:[0-9a-f]{64}$/);
  assert.ok(!today.includes(ip));
  assert.equal(await ipKey("waitlist", ip, evening), today, "one bucket for the whole UTC day");
  assert.notEqual(await ipKey("waitlist", ip, nextDay), today, "a new salt the next day");
  assert.notEqual(await ipKey("waitlist", "203.0.113.8", morning), today);
  assert.equal(
    await ipKey("magic-link", ip, morning),
    `magic-link:${today.slice("waitlist:".length)}`,
    "the route prefixes the bucket; the hash is per address and day",
  );
  // Not a bare hash of the address: without the secret the bucket can't be recomputed.
  assert.notEqual(today, `waitlist:${await hashToken(ip)}`);
});

test("emailKey is route:sha256(email), stable across days", async () => {
  const { emailKey } = await import("./index");
  assert.equal(
    await emailKey("magic-link", "ada@example.com"),
    `magic-link:${await hashToken("ada@example.com")}`,
  );
});

test("hit allows `limit` hits, then refuses with a Retry-After inside the window", { skip: skipLive }, async () => {
  const { hit } = await import("./index");
  const rule = { limit: 3, windowSeconds: 3600 };
  const bucket = drillBucket();

  for (let i = 1; i <= rule.limit; i += 1) {
    assert.deepEqual(await hit(bucket, rule), { allowed: true }, `hit ${i} of ${rule.limit}`);
  }
  const refused = await hit(bucket, rule);
  assert.equal(refused.allowed, false);
  if (refused.allowed) return;

  // The window is aligned to the epoch, so the expected value is computable.
  const nowSeconds = Date.now() / 1000;
  const windowEnd = Math.floor(nowSeconds / rule.windowSeconds) * rule.windowSeconds + rule.windowSeconds;
  const expected = Math.ceil(windowEnd - nowSeconds);
  assert.ok(refused.retryAfterSeconds >= 1 && refused.retryAfterSeconds <= rule.windowSeconds);
  assert.ok(
    Math.abs(refused.retryAfterSeconds - expected) <= 5,
    `retryAfter ${refused.retryAfterSeconds} ≈ ${expected} (app/db clock skew ≤ 5 s)`,
  );
});

test("concurrent hits are counted exactly (one atomic upsert per hit)", { skip: skipLive }, async () => {
  const { hit } = await import("./index");
  const rule = RATE_LIMITS.waitlistPerIp;
  const bucket = drillBucket();
  const results = await Promise.all(Array.from({ length: rule.limit + 3 }, () => hit(bucket, rule)));
  assert.equal(results.filter((r) => r.allowed).length, rule.limit);
});

test("pruneBuckets deletes buckets older than the retention and keeps recent ones", { skip: skipLive }, async () => {
  const { hit, pruneBuckets } = await import("./index");
  const { db } = await import("../db");
  const { rateLimits } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");

  const stale = drillBucket();
  const fresh = drillBucket();
  await db.insert(rateLimits).values({
    bucket: stale,
    windowStart: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    count: 1,
  });
  await hit(fresh, RATE_LIMITS.waitlistPerIp);

  assert.ok((await pruneBuckets()) >= 1);
  assert.equal((await db.select().from(rateLimits).where(eq(rateLimits.bucket, stale))).length, 0);
  assert.equal((await db.select().from(rateLimits).where(eq(rateLimits.bucket, fresh))).length, 1);
});

test("peek reports a full bucket without counting a hit", { skip: skipLive }, async () => {
  const { hit, peek } = await import("./index");
  const rule = { limit: 2, windowSeconds: 3600 };
  const bucket = drillBucket();

  assert.deepEqual(await peek(bucket, rule), { allowed: true }, "an absent bucket is not full");
  await hit(bucket, rule);
  assert.deepEqual(await peek(bucket, rule), { allowed: true });
  assert.deepEqual(await peek(bucket, rule), { allowed: true }, "peeking did not count");
  await hit(bucket, rule);
  const full = await peek(bucket, rule);
  assert.equal(full.allowed, false);
  if (!full.allowed) assert.ok(full.retryAfterSeconds >= 1 && full.retryAfterSeconds <= rule.windowSeconds);
});
