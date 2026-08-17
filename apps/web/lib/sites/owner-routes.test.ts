/**
 * The owner-route drills — E05 task 010.
 *
 * NO MOCKS (project rule). Every assertion below runs `keepOwnedSite`,
 * `demoteOwnedSite` and `swapOwnedSites` — the exact functions the three
 * `route.ts` files delegate to — against the real dev Neon branch: real `user`,
 * `profiles` and `sites` rows, real transactions, real row locks. The only
 * thing the route files add on top is the session lookup, which `next/headers`
 * makes uncallable outside a Next request scope and which
 * `e2e/owner-sites-api.spec.ts` covers over the wire instead.
 *
 * TWO PROPERTIES ARE LOAD-BEARING HERE and are asserted byte for byte rather
 * than by status code alone:
 *
 *   1. A site that does not exist, a site owned by somebody else and an id that
 *      is not a uuid produce the IDENTICAL body. "You don't own this" is an
 *      existence oracle over other people's pages.
 *   2. Being at `KEPT_PAGE_LIMIT` is HTTP 200 with `outcome: "owned_draft"`,
 *      never a 4xx. The cap degrades; it does not reject.
 *
 * Nothing here touches R2, KV or the purge endpoint, because the module under
 * test must not either.
 *
 * The drills SKIP when `DATABASE_URL` is absent: CI runs `pnpm test` on fork PRs
 * with no cloud secrets. Run them locally with
 *
 *   pnpm --filter @kept/web test:unit
 *
 * Every row created here is deleted in `after`.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  DRAFT_GRACE_DAYS,
  DRAFT_TTL_DAYS,
  KEPT_PAGE_LIMIT,
  demoteResultSchema,
  keepResultSchema,
  swapResultSchema,
} from "@kept/shared";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const createdSites = new Set<string>();
const createdProfiles = new Set<string>();

async function schema() {
  return import("../db/schema");
}

async function client() {
  const { db } = await import("../db/index");
  return db;
}

/** A brand-new account with zero kept pages. */
async function makeProfile(): Promise<string> {
  const db = await client();
  const { profiles, user } = await schema();
  const id = crypto.randomUUID();
  const email = `e05-010-${id}@kept.invalid`;
  await db.insert(user).values({ id, name: "E05-010 drill", email, emailVerified: true });
  await db.insert(profiles).values({ id, email, plan: "free" });
  createdProfiles.add(id);
  return id;
}

interface MakeSite {
  /** null → anonymous (has a token, has a clock). */
  ownerId?: string | null;
  /** Owned rows only: no clock → kept, clock → owned draft. */
  kept?: boolean;
}

async function makeSite({ ownerId = null, kept = false }: MakeSite = {}): Promise<{
  id: string;
  slug: string;
}> {
  const db = await client();
  const { sites } = await schema();
  const id = crypto.randomUUID();
  const slug = `e05-010-${id.slice(0, 12)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DRAFT_TTL_DAYS * MS_PER_DAY);

  await db.insert(sites).values({
    id,
    slug,
    status: "live",
    region: "auto",
    ownerId,
    anonTokenHash: ownerId === null ? `e05-010-${id}` : null,
    publisherHash: "e05-010-drill",
    expiresAt: kept ? null : expiresAt,
    purgeAfter: kept ? null : new Date(expiresAt.getTime() + DRAFT_GRACE_DAYS * MS_PER_DAY),
    claimedAt: ownerId === null ? null : now,
    contentHash: "e05-010",
    sizeBytes: 128,
  });
  createdSites.add(id);
  return { id, slug };
}

async function readSite(siteId: string) {
  const db = await client();
  const { sites } = await schema();
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select().from(sites).where(eq(sites.id, siteId));
  if (!row) throw new Error(`Drill row ${siteId} vanished.`);
  return row;
}

/** The kept-ness predicate, asked of the database rather than of a result object. */
async function keptCount(profileId: string): Promise<number> {
  const db = await client();
  const { sites } = await schema();
  const { and, eq, isNull, sql } = await import("drizzle-orm");
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sites)
    .where(
      and(eq(sites.ownerId, profileId), isNull(sites.expiresAt), eq(sites.status, "live")),
    );
  return row?.count ?? 0;
}

/** `n` kept pages against one profile, the way the cap drills need them. */
async function fillKept(profileId: string, n: number): Promise<{ id: string; slug: string }[]> {
  const made: { id: string; slug: string }[] = [];
  for (let i = 0; i < n; i++) made.push(await makeSite({ ownerId: profileId, kept: true }));
  return made;
}

/** A `timestamp` column the drill has just asserted must be set. */
function stamp(value: Date | null): Date {
  if (!value) throw new Error("Expected a timestamp, got null.");
  return value;
}

after(async () => {
  if (skipLive) return;
  const db = await client();
  const { profiles, sites, user } = await schema();
  const { inArray } = await import("drizzle-orm");

  if (createdSites.size > 0) {
    await db.delete(sites).where(inArray(sites.id, [...createdSites]));
  }
  if (createdProfiles.size > 0) {
    // `profiles.id` FKs `user.id` with `on delete cascade`, so one delete does both.
    await db.delete(profiles).where(inArray(profiles.id, [...createdProfiles]));
    await db.delete(user).where(inArray(user.id, [...createdProfiles]));
  }
  await db.$client.end();
});

// ── POST /api/sites/:id/keep ────────────────────────────────────────────────

test(
  "keep, under cap: an owned draft becomes kept and the response parses as a KeepResult",
  { skip: skipLive },
  async () => {
    const { keepOwnedSite } = await import("./owner-routes");
    const profileId = await makeProfile();
    const site = await makeSite({ ownerId: profileId });

    const outcome = await keepOwnedSite(site.id, profileId);

    assert.equal(outcome.ok, true);
    assert.equal(outcome.status, 200, "keeping is never anything but a success here");
    // The contract E06 is a client of, asserted rather than assumed.
    const body = keepResultSchema.parse(outcome.body);
    assert.equal(body.outcome, "kept");
    assert.equal(body.siteId, site.id);
    assert.equal(body.slug, site.slug);
    assert.deepEqual(body.quota, {
      limit: KEPT_PAGE_LIMIT,
      used: 1,
      remaining: KEPT_PAGE_LIMIT - 1,
    });

    const row = await readSite(site.id);
    assert.equal(row.expiresAt, null, "the clock is off");
    assert.equal(row.purgeAfter, null);
    assert.equal(row.status, "live", "keep never moves status");
    assert.equal(await keptCount(profileId), 1);
  },
);

test(
  "keep, at cap: HTTP 200 with owned_draft and the clock retained — never a 4xx",
  { skip: skipLive },
  async () => {
    const { keepOwnedSite } = await import("./owner-routes");
    const profileId = await makeProfile();
    await fillKept(profileId, KEPT_PAGE_LIMIT);
    const site = await makeSite({ ownerId: profileId });
    const before = await readSite(site.id);

    const outcome = await keepOwnedSite(site.id, profileId);

    assert.equal(outcome.ok, true, "the cap is a branch, not an error");
    assert.equal(outcome.status, 200);
    const body = keepResultSchema.parse(outcome.body);
    assert.equal(body.outcome, "owned_draft");
    assert.deepEqual(body.quota, { limit: KEPT_PAGE_LIMIT, used: KEPT_PAGE_LIMIT, remaining: 0 });
    assert.equal(
      body.outcome === "owned_draft" ? body.expiresAt : null,
      stamp(before.expiresAt).toISOString(),
      "the existing countdown is retained, not restarted",
    );

    const row = await readSite(site.id);
    assert.equal(row.status, "live", "an owned draft is live and already serving");
    assert.equal(
      await keptCount(profileId),
      KEPT_PAGE_LIMIT,
      "the account never exceeds the cap",
    );
  },
);

test(
  "keep is idempotent: keeping an already-kept page is a no-op success",
  { skip: skipLive },
  async () => {
    const { keepOwnedSite } = await import("./owner-routes");
    const profileId = await makeProfile();
    const site = await makeSite({ ownerId: profileId, kept: true });

    const outcome = await keepOwnedSite(site.id, profileId);

    assert.equal(outcome.ok, true);
    const body = keepResultSchema.parse(outcome.body);
    assert.equal(body.outcome, "kept");
    assert.deepEqual(body.quota, {
      limit: KEPT_PAGE_LIMIT,
      used: 1,
      remaining: KEPT_PAGE_LIMIT - 1,
    });
    assert.equal(await keptCount(profileId), 1, "no second slot was consumed");
  },
);

test(
  "keep does not open the anonymous door: an unclaimed draft is 404 to a signed-in stranger",
  { skip: skipLive },
  async () => {
    const { keepOwnedSite } = await import("./owner-routes");
    const profileId = await makeProfile();
    const anonymous = await makeSite();

    const outcome = await keepOwnedSite(anonymous.id, profileId);

    assert.equal(outcome.ok, false);
    assert.equal(
      outcome.status,
      404,
      "the anonymous→owned door is bearer-token authority behind /api/anon/, not this route",
    );
    const row = await readSite(anonymous.id);
    assert.equal(row.ownerId, null, "and nothing was written");
    assert.notEqual(row.anonTokenHash, null);
  },
);

// ── POST /api/sites/:id/demote ──────────────────────────────────────────────

test(
  "demote: a fresh clock, status still live, quota returned, no store touched",
  { skip: skipLive },
  async () => {
    const { demoteOwnedSite } = await import("./owner-routes");
    const profileId = await makeProfile();
    const kept = await fillKept(profileId, 2);
    const target = kept[0]!;
    const before = await readSite(target.id);
    assert.equal(before.expiresAt, null, "precondition: the page is kept");

    const outcome = await demoteOwnedSite(target.id, profileId);

    assert.equal(outcome.ok, true);
    assert.equal(outcome.status, 200);
    const body = demoteResultSchema.parse(outcome.body);
    assert.equal(body.siteId, target.id);
    assert.equal(body.slug, target.slug);
    assert.deepEqual(
      body.quota,
      { limit: KEPT_PAGE_LIMIT, used: 1, remaining: KEPT_PAGE_LIMIT - 1 },
      "the freed slot is visible without a second request",
    );

    const row = await readSite(target.id);
    const expiresAt = stamp(row.expiresAt);
    const purgeAfter = stamp(row.purgeAfter);
    assert.equal(
      Math.round((expiresAt.getTime() - Date.now()) / MS_PER_DAY),
      DRAFT_TTL_DAYS,
      "a fresh DRAFT_TTL_DAYS clock, from @kept/shared",
    );
    assert.equal(
      Math.round((purgeAfter.getTime() - expiresAt.getTime()) / MS_PER_DAY),
      DRAFT_GRACE_DAYS,
    );
    assert.equal(row.status, "live", "the page keeps serving at the same URL");
    assert.equal(row.ownerId, profileId, "a demoted page is an OWNED draft");
    assert.ok(row.claimedAt instanceof Date, "claimed_at survives a demote");
    assert.equal(row.slug, before.slug, "archive, don't delete — nothing is removed");
  },
);

test(
  "demoting an already-draft page is a no-op success, and keeping it again has no cooldown",
  { skip: skipLive },
  async () => {
    const { demoteOwnedSite, keepOwnedSite } = await import("./owner-routes");
    const profileId = await makeProfile();
    const site = await makeSite({ ownerId: profileId });

    const first = await demoteOwnedSite(site.id, profileId);
    assert.equal(first.ok, true, "demoting a draft is not an error");
    assert.equal(first.status, 200);
    assert.ok(stamp((await readSite(site.id)).expiresAt) instanceof Date);

    // Demote → immediate regret → keep. No cooldown, by design.
    const kept = await keepOwnedSite(site.id, profileId);
    assert.equal(kept.ok, true);
    assert.equal(keepResultSchema.parse(kept.body).outcome, "kept");
    assert.equal((await readSite(site.id)).expiresAt, null, "kept again, immediately");
  },
);

// ── POST /api/sites/swap ────────────────────────────────────────────────────

test(
  "swap: one transaction, and the account lands at exactly KEPT_PAGE_LIMIT",
  { skip: skipLive },
  async () => {
    const { swapOwnedSites } = await import("./owner-routes");
    const profileId = await makeProfile();
    const kept = await fillKept(profileId, KEPT_PAGE_LIMIT);
    const incoming = await makeSite({ ownerId: profileId });
    const outgoing = kept[0]!;

    const outcome = await swapOwnedSites(
      { demote: outgoing.id, keep: incoming.id },
      profileId,
    );

    assert.equal(outcome.ok, true);
    assert.equal(outcome.status, 200);
    const body = swapResultSchema.parse(outcome.body);
    assert.equal(body.demoted.siteId, outgoing.id);
    assert.equal(body.kept.siteId, incoming.id);
    assert.equal(body.kept.outcome, "kept", "the swap freed the slot it then used");
    assert.deepEqual(
      body.demoted.quota,
      body.kept.quota,
      "both halves report the same post-swap quota",
    );
    assert.deepEqual(body.kept.quota, {
      limit: KEPT_PAGE_LIMIT,
      used: KEPT_PAGE_LIMIT,
      remaining: 0,
    });

    assert.equal(
      await keptCount(profileId),
      KEPT_PAGE_LIMIT,
      "never KEPT_PAGE_LIMIT − 1, never + 1",
    );
    assert.ok(
      stamp((await readSite(outgoing.id)).expiresAt) instanceof Date,
      "the demoted half is back on a clock",
    );
    assert.equal((await readSite(incoming.id)).expiresAt, null);
  },
);

test(
  "swap refuses demote === keep with a 400 — that is a caller bug, not a cap branch",
  { skip: skipLive },
  async () => {
    const { swapOwnedSites } = await import("./owner-routes");
    const profileId = await makeProfile();
    const kept = await fillKept(profileId, KEPT_PAGE_LIMIT);
    const site = kept[0]!;

    const outcome = await swapOwnedSites({ demote: site.id, keep: site.id }, profileId);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, 400);
    assert.equal(
      await keptCount(profileId),
      KEPT_PAGE_LIMIT,
      "and nothing moved — the page is still kept",
    );
  },
);

test(
  "swap rejects a malformed body without touching the account",
  { skip: skipLive },
  async () => {
    const { swapOwnedSites } = await import("./owner-routes");
    const profileId = await makeProfile();
    await fillKept(profileId, 1);

    for (const raw of [null, {}, { demote: "not-a-uuid", keep: crypto.randomUUID() }, "x"]) {
      const outcome = await swapOwnedSites(raw, profileId);
      assert.equal(outcome.ok, false, `expected a refusal for ${JSON.stringify(raw)}`);
      assert.equal(outcome.status, 400);
    }
    assert.equal(await keptCount(profileId), 1);
  },
);

test(
  "swap is atomic across owners: a keep half the caller does not own leaves the demote half kept",
  { skip: skipLive },
  async () => {
    const { swapOwnedSites } = await import("./owner-routes");
    const mine = await makeProfile();
    const theirs = await makeProfile();
    const outgoing = (await fillKept(mine, 1))[0]!;
    const someoneElses = await makeSite({ ownerId: theirs });

    const outcome = await swapOwnedSites(
      { demote: outgoing.id, keep: someoneElses.id },
      mine,
    );

    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, 404);
    assert.equal(
      (await readSite(outgoing.id)).expiresAt,
      null,
      "the transaction rolled back — my page is still kept",
    );
    assert.equal(await keptCount(mine), 1);
  },
);

// ── The no-oracle property, across all three routes ─────────────────────────

test(
  "not-found and not-yours are byte-identical on every route, including a malformed id",
  { skip: skipLive },
  async () => {
    const { demoteOwnedSite, keepOwnedSite, swapOwnedSites } = await import("./owner-routes");
    const mine = await makeProfile();
    const theirs = await makeProfile();
    await fillKept(mine, 1);
    const theirKept = (await fillKept(theirs, 1))[0]!;
    const nonExistent = crypto.randomUUID();

    // Every reason a caller can invent, on every route that answers one.
    const ids = [theirKept.id, nonExistent, "not-a-uuid-at-all", ""];
    const bodies: string[] = [];

    for (const id of ids) {
      for (const call of [keepOwnedSite, demoteOwnedSite]) {
        const outcome = await call(id, mine);
        assert.equal(outcome.ok, false, `${id} must not resolve`);
        assert.equal(outcome.status, 404);
        bodies.push(JSON.stringify(outcome.body));
      }
    }

    // The swap route reaches the same refusal through `swapKept`.
    const swapped = await swapOwnedSites(
      { demote: theirKept.id, keep: crypto.randomUUID() },
      mine,
    );
    assert.equal(swapped.ok, false);
    assert.equal(swapped.status, 404);
    bodies.push(JSON.stringify(swapped.body));

    assert.equal(
      new Set(bodies).size,
      1,
      `all ${bodies.length} refusals must be one body — a difference is an existence oracle: ${[...new Set(bodies)].join(" | ")}`,
    );

    // And their page is untouched by any of it.
    assert.equal((await readSite(theirKept.id)).ownerId, theirs);
    assert.equal((await readSite(theirKept.id)).expiresAt, null);
  },
);

test(
  "the signed-out refusal is a 401 the route handlers return before any database work",
  { skip: skipLive },
  async () => {
    const { signedOut } = await import("./owner-routes");
    const refusal = signedOut();

    assert.equal(refusal.ok, false);
    assert.equal(refusal.status, 401);
    // Distinguishable from the 404 by status, which is what a caller acts on:
    // "sign in again" and "that page is gone" are different remedies.
    const { ownerNotFound } = await import("./owner-routes");
    assert.notEqual(refusal.status, ownerNotFound().status);
  },
);
