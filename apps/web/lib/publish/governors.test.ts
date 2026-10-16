/**
 * The volume governors (E07 task 002, AC27; PRD §6.15) against the real dev
 * Neon branch — `hit()` on `rate_limits`, no stubs.
 *
 * WHAT IS REAL AND WHAT IS SEEDED. Every bucket is filled through the real
 * `hit()` (concurrently, which also proves the count is exact under
 * contention), with ONE exception: the global cap is 1,000, and the drill
 * raises its test-scoped bucket to one below the limit with a single UPDATE
 * rather than a thousand round trips. The drill's buckets are its own — a
 * fresh publisher identity per test and a test-scoped global bucket — so a run
 * never spends the real `publish:global` beyond its one real publish, and every
 * bucket it wrote is deleted in `after`.
 *
 * KV BUDGET: one real publish (1 KV write + 1 delete in teardown). Every other
 * drill is refused before a store is touched.
 *
 * Imports are dynamic and inside tests: `lib/db` needs `DATABASE_URL`, and the
 * drills skip without the dev credentials (CI on fork PRs).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { PUBLISH_RATE_LIMITS, type RateLimitRule } from "@kept/shared";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const LIVE_VARS = [
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_AUTO",
  "KV_NAMESPACE_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "KEPT_BASE_DOMAIN",
  "NEXT_PUBLIC_APP_URL",
  "PUBLISHER_HASH_SALT",
] as const;

const missing = LIVE_VARS.filter((name) => !process.env[name]);
const skipLive =
  missing.length > 0
    ? `dev credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local`
    : false;
const skipDb = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const run = `e07-002-${crypto.randomUUID().slice(0, 8)}`;

/** Every bucket a drill touched, deleted in `after`. */
const buckets = new Set<string>();
/** Slugs this file published, torn down in `after`. */
const created = new Set<string>();

/** A publisher nobody else has: the governors key on IP + UA. */
const freshPublisher = () => ({
  ip: "203.0.113.70",
  userAgent: `kept-${run}-${crypto.randomUUID().slice(0, 8)}/1.0`,
});

const pageHtml = (marker: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marker}</title></head><body><h1>${marker}</h1></body></html>\n`;

async function publisherKey(who: { ip: string; userAgent: string }): Promise<string> {
  const { hashPublisher } = await import("@kept/shared");
  const { publisherHashSalt } = await import("../storage/env");
  return hashPublisher(who.ip, who.userAgent, publisherHashSalt());
}

/** The live count of `bucket` in `rule`'s current window; 0 when it has no row. */
async function count(bucket: string, rule: RateLimitRule): Promise<number> {
  buckets.add(bucket);
  const { sql } = await import("drizzle-orm");
  const { db } = await import("../db");
  const rows = await db.execute<{ count: number }>(sql`
    select count from rate_limits
    where bucket = ${bucket}
      and window_start = to_timestamp(floor(extract(epoch from now()) / ${rule.windowSeconds}) * ${rule.windowSeconds})
  `);
  return rows[0]?.count ?? 0;
}

/** Spend `n` hits from `bucket` through the real limiter, concurrently. */
async function fill(bucket: string, rule: RateLimitRule, n: number): Promise<void> {
  buckets.add(bucket);
  const { hit } = await import("../rate-limit");
  await Promise.all(Array.from({ length: n }, () => hit(bucket, rule)));
}

after(async () => {
  if (skipDb) return;
  const { eq, inArray } = await import("drizzle-orm");
  const { db, closeDb } = await import("../db");
  const { rateLimits, sites, siteVersions } = await import("../db/schema");

  if (!skipLive) {
    const { removeManifest } = await import("../storage/manifest");
    const { pageObjectKey, r2Store } = await import("../storage/r2");
    for (const slug of created) {
      const [row] = await db.select({ id: sites.id }).from(sites).where(eq(sites.slug, slug));
      await removeManifest(slug).catch(() => undefined);
      if (!row) continue;
      const versions = await db
        .select({ id: siteVersions.id })
        .from(siteVersions)
        .where(eq(siteVersions.siteId, row.id));
      for (const version of versions) {
        await r2Store()
          .delete(pageObjectKey(row.id, version.id))
          .catch(() => undefined);
      }
      await db.delete(sites).where(eq(sites.id, row.id));
    }
    await (await import("../testing/pending-purges")).clearPendingPurges(created);
  }
  if (buckets.size > 0) await db.delete(rateLimits).where(inArray(rateLimits.bucket, [...buckets]));
  await closeDb();
});

test("the 31st new page in an hour is a 429 with retry_after_seconds", { skip: skipLive }, async () => {
  const { publishPage } = await import("./pipeline");
  const who = freshPublisher();
  const key = await publisherKey(who);
  const { perPublisherHour, perPublisherDay } = PUBLISH_RATE_LIMITS;

  await fill(`publish:${key}`, perPublisherHour, perPublisherHour.limit);
  assert.equal(await count(`publish:${key}`, perPublisherHour), 30, "30 new pages already this hour");

  const outcome = await publishPage({ html: pageHtml(`${run}-31st`) }, who);
  console.log("[e07-002] 31st page →", outcome.ok ? outcome.status : outcome.body);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.status, 429);
  assert.equal(outcome.body.error, "rate_limited");
  assert.match(outcome.body.message, /30 new pages an hour/);
  const retry = outcome.body.retry_after_seconds;
  assert.ok(retry !== undefined && retry >= 1 && retry <= perPublisherHour.windowSeconds, `retry ${retry}`);
  assert.equal(
    await count(`publish:${key}:day`, perPublisherDay),
    0,
    "a refusal stops at the first rule: the day bucket is not spent",
  );
});

/** The one real page the rest of the drills operate on. */
let page: { who: { ip: string; userAgent: string }; key: string; html: string; anonToken: string; siteId: string } | null =
  null;

test("a deduped publish spends the request ceiling, not publish:<key>", { skip: skipLive }, async () => {
  const { publishPage } = await import("./pipeline");
  const { resolveAnonToken } = await import("./anon-token");
  const who = freshPublisher();
  const key = await publisherKey(who);
  const html = pageHtml(`${run}-dedup`);
  const { perPublisherHour, perPublisherDay, requestsPerPublisherHour } = PUBLISH_RATE_LIMITS;

  const first = await publishPage({ html }, who);
  assert.equal(first.ok, true, JSON.stringify(first.ok ? null : first.body));
  if (!first.ok) return;
  created.add(first.body.slug);
  assert.equal(first.body.deduped, false);

  const again = await publishPage({ html }, who);
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.body.deduped, true, "same publisher, same bytes: the existing page");
  assert.equal(again.body.slug, first.body.slug);

  assert.equal(await count(`publish:${key}`, perPublisherHour), 1, "the dedup hit spent no new-page budget");
  assert.equal(await count(`publish:${key}:day`, perPublisherDay), 1);
  assert.equal(await count(`publish-requests:${key}`, requestsPerPublisherHour), 2, "both requests count");

  const site = await resolveAnonToken(again.body.anonToken);
  assert.ok(site, "the rotated token resolves");
  page = { who, key, html, anonToken: again.body.anonToken, siteId: site.id };
});

test("the 121st request is a 429 BEFORE the dedup probe", { skip: skipLive }, async () => {
  assert.ok(page, "needs the page from the dedup drill");
  const { publishPage } = await import("./pipeline");
  const { resolveAnonToken } = await import("./anon-token");
  const { perPublisherHour, requestsPerPublisherHour } = PUBLISH_RATE_LIMITS;
  const bucket = `publish-requests:${page.key}`;

  const spent = await count(bucket, requestsPerPublisherHour);
  await fill(bucket, requestsPerPublisherHour, requestsPerPublisherHour.limit - spent);
  assert.equal(await count(bucket, requestsPerPublisherHour), 120);

  // The same bytes again: a dedup hit if the probe ran — it must not.
  const outcome = await publishPage({ html: page.html }, page.who);
  console.log("[e07-002] 121st request →", outcome.ok ? outcome.status : outcome.body);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.status, 429);
  assert.equal(outcome.body.error, "rate_limited");
  assert.match(outcome.body.message, /120 publish requests an hour/);
  assert.ok((outcome.body.retry_after_seconds ?? 0) >= 1);

  // The probe rotates the token on a dedup hit. The old one still resolving is
  // the proof the ceiling answered first.
  assert.ok(await resolveAnonToken(page.anonToken), "no dedup ran: the token was not rotated");
  assert.equal(await count(`publish:${page.key}`, perPublisherHour), 1, "the new-page budget is untouched");
});

test("the 61st anonymous replace of one page in an hour is a 429", { skip: skipLive }, async () => {
  assert.ok(page, "needs the page from the dedup drill");
  const { replacePage } = await import("./anon-manage");
  const { anonReplacePerSiteHour } = PUBLISH_RATE_LIMITS;
  const bucket = `anon-replace:${page.siteId}`;

  await fill(bucket, anonReplacePerSiteHour, anonReplacePerSiteHour.limit);

  const outcome = await replacePage(page.anonToken, { html: pageHtml(`${run}-replace`) }, "api");
  console.log("[e07-002] 61st replace →", outcome.ok ? outcome.status : outcome.body);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.status, 429);
  assert.equal(outcome.body.error, "rate_limited");
  assert.match(outcome.body.message, /60 replaces of this page an hour/);
  assert.ok((outcome.body.retry_after_seconds ?? 0) >= 1);
});

test("the global bucket counts across publishers, and its alert is throttled", { skip: skipDb }, async () => {
  const { sql } = await import("drizzle-orm");
  const { db } = await import("../db");
  const { checkRateLimit } = await import("./hooks");
  const { adminAlertBucket } = await import("../email/admin-alert");
  const { globalHour, globalCapAlertHour } = PUBLISH_RATE_LIMITS;

  const globalBucket = `${run}:publish:global`;
  const alertBucket = adminAlertBucket(globalBucket);
  const publisherA = `${run}-a`;
  const publisherB = `${run}-b`;
  for (const key of [publisherA, publisherB]) {
    buckets.add(`publish:${key}`);
    buckets.add(`publish:${key}:day`);
  }

  // The alert for this test bucket has already gone out this hour, so the trip
  // below proves it reaches the throttle without mailing anyone.
  await fill(alertBucket, globalCapAlertHour, 1);

  assert.deepEqual(await checkRateLimit(publisherA, globalBucket), { allowed: true });
  assert.equal(await count(globalBucket, globalHour), 1);

  // The one seeded value: one below the cap, without a thousand round trips.
  await db.execute(sql`
    update rate_limits set count = ${globalHour.limit - 1}
    where bucket = ${globalBucket}
      and window_start = to_timestamp(floor(extract(epoch from now()) / ${globalHour.windowSeconds}) * ${globalHour.windowSeconds})
  `);

  assert.deepEqual(
    await checkRateLimit(publisherB, globalBucket),
    { allowed: true },
    "publisher B takes the 1,000th slot",
  );

  const refused = await checkRateLimit(publisherA, globalBucket);
  console.log("[e07-002] global cap →", refused);
  assert.equal(refused.allowed, false, "publisher A, under its own limits, is refused by everyone's");
  if (refused.allowed) return;
  assert.match(refused.reason, /1000 new anonymous pages an hour/);
  assert.ok(refused.retryAfterSeconds >= 1 && refused.retryAfterSeconds <= globalHour.windowSeconds);

  const again = await checkRateLimit(publisherB, globalBucket);
  assert.equal(again.allowed, false);
  assert.equal(
    await count(alertBucket, globalCapAlertHour),
    3,
    "each trip consulted the hourly alert throttle (1 seeded + 2 trips), so at most one mail went out",
  );
  assert.equal(await count(`publish:${publisherA}`, PUBLISH_RATE_LIMITS.perPublisherHour), 2);
});
