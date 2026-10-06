/**
 * The keep / demote / swap drills — E05 task 007, hardened by E06 task 004.
 *
 * NO MOCKS (project rule). Every assertion below runs against the real dev Neon
 * branch: real `user`, `profiles` and `sites` rows, real transactions, real row
 * locks. The concurrency drills in particular are only meaningful against a real
 * Postgres — they are the ones that prove two tabs one slot short of the limit
 * cannot both keep (AC13).
 *
 * THE LIMIT IS THE PLAN'S (D1, E06 task 003). Drill accounts are `free` unless a
 * drill says otherwise, so the cap below is `limitsFor("free").keptPages` — never
 * a literal and never `KEPT_PAGE_LIMIT`, which is for surfaces with no plan.
 * Cap-filling rows are seeded in ONE multi-row insert: real rows, not a mock,
 * and the limit is large enough that one round trip per row would dominate the
 * suite.
 *
 * Only the LATE KEEP touches a store, because it is the only primitive that may:
 * its drills write a real manifest through `writeManifest` to the dev R2 bucket
 * and KV namespace and assert the slug pointer that write leaves behind. They
 * additionally SKIP without the store credentials; every other drill proves the
 * opposite — the ordinary keep, demote and swap write nothing outside Postgres.
 *
 * The drills SKIP when `DATABASE_URL` is absent: CI runs `pnpm test` on fork PRs
 * with no cloud secrets. Run them locally with
 *
 *   pnpm --filter @kept/web test:unit
 *
 * Every row and manifest created here is removed in `after`.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  DRAFT_GRACE_DAYS,
  DRAFT_TTL_DAYS,
  limitsFor,
  type Plan,
  type SiteStatus,
  type StudioErrorCode,
} from "@kept/shared";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

/** The late-keep drills additionally write R2 + KV and purge the dev zone. */
const STORE_VARS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_AUTO",
  "KV_NAMESPACE_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "KEPT_BASE_DOMAIN",
] as const;
const missingStores = STORE_VARS.filter((name) => !process.env[name]);
const skipStores =
  skipLive ||
  (missingStores.length > 0 ? `store credentials absent (${missingStores.join(", ")})` : false);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The cap every `free` drill account is held to. */
const FREE_LIMIT = limitsFor("free").keptPages;

/** Everything created by these drills, torn down in `after`. */
const createdSites = new Set<string>();
const createdProfiles = new Set<string>();
/** Slugs whose manifest a late keep wrote, removed again in `after`. */
const createdManifests = new Set<string>();

async function schema() {
  return import("../db/schema");
}

async function client() {
  const { db } = await import("../db/index");
  return db;
}

/** A brand-new account with zero kept pages. */
async function makeProfile(plan: Plan = "free"): Promise<string> {
  const db = await client();
  const { profiles, user } = await schema();
  const id = crypto.randomUUID();
  await db.insert(user).values({
    id,
    name: "E05-007 drill",
    email: `e05-007-${id}@kept.invalid`,
    emailVerified: true,
  });
  await db.insert(profiles).values({ id, email: `e05-007-${id}@kept.invalid`, plan });
  createdProfiles.add(id);
  return id;
}

interface MakeSite {
  /** null → anonymous (has a token, has a clock). */
  ownerId?: string | null;
  /** Owned rows only: no clock → kept, clock → owned draft. */
  kept?: boolean;
  /**
   * Anything other than `live` for the status drills: `archived` and
   * `quarantined` rows are clockless and owned, so they look kept to any
   * predicate that forgets the status clause.
   */
  status?: SiteStatus;
  /**
   * Drafts only: days from now until `expires_at`, negative for a clock that has
   * already run out. Default: a fresh `DRAFT_TTL_DAYS`.
   */
  expiresInDays?: number;
  /** Drafts only: the grace window after `expires_at`; null → none recorded. */
  graceDays?: number | null;
  /** Give the row a `site_versions` row, so a late keep can build a manifest. */
  withVersion?: boolean;
}

/** One drill row's column values, tracked for teardown. Inserting is the caller's. */
function siteRow({
  ownerId = null,
  kept = false,
  status = "live",
  expiresInDays = DRAFT_TTL_DAYS,
  graceDays = DRAFT_GRACE_DAYS,
}: MakeSite = {}) {
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInDays * MS_PER_DAY);
  createdSites.add(id);
  return {
    id,
    slug: `e05-007-${id.slice(0, 12)}`,
    status,
    region: "auto" as const,
    ownerId,
    anonTokenHash: ownerId === null ? `e05-007-${id}` : null,
    publisherHash: "e05-007-drill",
    expiresAt: kept ? null : expiresAt,
    purgeAfter:
      kept || graceDays === null
        ? null
        : new Date(expiresAt.getTime() + graceDays * MS_PER_DAY),
    claimedAt: ownerId === null ? null : now,
    contentHash: "e05-007",
    sizeBytes: 128,
    // A minute in the past, so a write that moves `updated_at` is visible as a
    // strictly later value rather than racing the insert's own `now()`.
    updatedAt: new Date(now.getTime() - 60_000),
  };
}

async function makeSite(
  options: MakeSite = {},
): Promise<{ id: string; slug: string; versionId: string | null }> {
  const db = await client();
  const { sites, siteVersions } = await schema();
  const row = siteRow(options);
  const versionId = options.withVersion ? crypto.randomUUID() : null;
  await db.insert(sites).values({ ...row, currentVersionId: versionId });
  if (versionId) {
    const { pageObjectKey } = await import("../storage/r2");
    // Cascades away with the site in `after`.
    await db.insert(siteVersions).values({
      id: versionId,
      siteId: row.id,
      region: "auto",
      r2Key: pageObjectKey(row.id, versionId),
      contentHash: "e05-007",
      sizeBytes: 128,
    });
  }
  return { id: row.id, slug: row.slug, versionId };
}

/** An owned draft whose clock ran out yesterday, still inside its grace window. */
function expiredInGrace(ownerId: string): MakeSite {
  return { ownerId, status: "expired", expiresInDays: -1, withVersion: true };
}

/** `call` must refuse with exactly this studio code — and nothing else. */
async function refusedWith(call: () => Promise<unknown>, code: StudioErrorCode): Promise<void> {
  const { StudioRefusal } = await import("./studio-refusal");
  await assert.rejects(call, (err: unknown) => {
    assert.ok(err instanceof StudioRefusal, `expected a StudioRefusal, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    return true;
  });
}

/** The slug pointer `writeManifest` leaves in R2 — the proof a manifest was written. */
async function pointerFor(slug: string): Promise<Record<string, unknown> | null> {
  const { pointerKey } = await import("../storage/manifest");
  const { r2Store } = await import("../storage/r2");
  const pointer = await r2Store().get(pointerKey(slug));
  return pointer === null ? null : (JSON.parse(pointer) as Record<string, unknown>);
}

async function readSite(siteId: string) {
  const db = await client();
  const { sites } = await schema();
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select().from(sites).where(eq(sites.id, siteId));
  if (!row) throw new Error(`Drill row ${siteId} vanished.`);
  return row;
}

/** A `timestamp` column the drill has just asserted must be set. */
function stamp(value: Date | null): Date {
  if (!value) throw new Error("Expected a timestamp, got null.");
  return value;
}

/**
 * The kept-ness predicate, asked of the database rather than of a result object.
 *
 * It composes the module's own exported `isKeptCondition` rather than re-typing
 * the WHERE clause. A drill that spells the predicate a second time is a drill
 * that passes while the two definitions drift apart, which is precisely the
 * failure the whole arrangement exists to prevent — the assertion has to be
 * "these agree about reality", not "these two copies of a clause agree".
 */
async function keptCount(profileId: string): Promise<number> {
  const db = await client();
  const { sites } = await schema();
  const { sql } = await import("drizzle-orm");
  const { isKeptCondition } = await import("./keep");
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sites)
    .where(isKeptCondition(profileId));
  return row?.count ?? 0;
}

/** `n` kept pages against one profile, in ONE insert — the way the cap drills need them. */
async function fillKept(profileId: string, n: number): Promise<void> {
  if (n === 0) return;
  const db = await client();
  const { sites } = await schema();
  await db
    .insert(sites)
    .values(Array.from({ length: n }, () => siteRow({ ownerId: profileId, kept: true })));
}

after(async () => {
  if (skipLive) return;
  const db = await client();
  const { profiles, sites, user } = await schema();
  const { inArray } = await import("drizzle-orm");

  if (createdManifests.size > 0) {
    // Pointer, then KV, then purge. No page object was ever written for these
    // rows — a manifest only POINTS at one — so there are no bytes to delete.
    const { removeManifest } = await import("../storage/manifest");
    for (const slug of createdManifests) {
      await removeManifest(slug).catch(() => undefined);
    }
  }
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

test(
  "under cap: an anonymous draft becomes kept — clocks and token cleared, status untouched",
  { skip: skipLive },
  async () => {
    const { keepSite } = await import("./keep");
    const profileId = await makeProfile();
    const site = await makeSite();

    const before = await readSite(site.id);
    const result = await keepSite(site.id, profileId, { expectAnonymous: true });

    assert.equal(result.outcome, "kept");
    assert.equal(result.siteId, site.id);
    assert.equal(result.slug, site.slug);
    assert.deepEqual(result.quota, { limit: FREE_LIMIT, used: 1, remaining: FREE_LIMIT - 1 });

    const after_ = await readSite(site.id);
    assert.equal(after_.ownerId, profileId);
    assert.equal(after_.expiresAt, null);
    assert.equal(after_.purgeAfter, null);
    assert.equal(after_.anonTokenHash, null, "the bearer token dies on keep");
    assert.ok(after_.claimedAt instanceof Date, "claimed_at is stamped on the first keep");
    assert.equal(after_.status, before.status, "keep never moves status");
    assert.equal(await keptCount(profileId), 1);
  },
);

test(
  "LATENT BUG 1 (failing-first): keeping an owned archived or removed row is not-found and changes not one column",
  { skip: skipLive },
  async () => {
    const { keepSite, SiteNotFoundError } = await import("./keep");
    const profileId = await makeProfile();

    // With a clock and without one: E06's delete archives a draft and a kept
    // page alike, and E07's takedown can land on either.
    for (const status of ["archived", "removed"] as const) {
      for (const kept of [false, true]) {
        const { id } = await makeSite({ ownerId: profileId, kept, status });
        const before = await readSite(id);

        await assert.rejects(() => keepSite(id, profileId), SiteNotFoundError);

        assert.deepEqual(
          await readSite(id),
          before,
          `an owned ${status} row (${kept ? "clockless" : "with a clock"}) must be byte-identical after the refused keep`,
        );
      }
    }
    assert.equal(await keptCount(profileId), 0, "nothing was kept");
  },
);

test(
  "an expired row past its grace window — or with none recorded — is not found, and untouched (edge case 13)",
  { skip: skipLive },
  async () => {
    const { keepSite, SiteNotFoundError } = await import("./keep");
    const profileId = await makeProfile();

    const pastGrace = await makeSite({
      ownerId: profileId,
      status: "expired",
      expiresInDays: -(DRAFT_GRACE_DAYS + 2),
      withVersion: true,
    });
    const noGrace = await makeSite({
      ownerId: profileId,
      status: "expired",
      expiresInDays: -1,
      graceDays: null,
      withVersion: true,
    });

    for (const site of [pastGrace, noGrace]) {
      const before = await readSite(site.id);
      await assert.rejects(() => keepSite(site.id, profileId), SiteNotFoundError);
      assert.deepEqual(await readSite(site.id), before, "the page is gone; nothing is revived");
    }
  },
);

test(
  "a flagged page (under_review / quarantined) is not_allowed_in_status, draft or kept, and untouched",
  { skip: skipLive },
  async () => {
    const { keepSite } = await import("./keep");
    const profileId = await makeProfile();

    for (const status of ["under_review", "quarantined"] as const) {
      for (const kept of [false, true]) {
        const { id } = await makeSite({ ownerId: profileId, kept, status });
        const before = await readSite(id);

        await refusedWith(() => keepSite(id, profileId), "not_allowed_in_status");

        assert.deepEqual(
          await readSite(id),
          before,
          `a ${status} page (${kept ? "kept" : "draft"}) must not be made permanent by a keep`,
        );
      }
    }
  },
);

test(
  "owner door at the cap: 409 at_kept_limit, and the owned draft keeps exactly the row it had",
  { skip: skipLive },
  async () => {
    const { keepSite } = await import("./keep");
    const profileId = await makeProfile();
    await fillKept(profileId, FREE_LIMIT);
    const { id } = await makeSite({ ownerId: profileId });
    const before = await readSite(id);

    // The page is ALREADY an owned draft, so there is nothing for the cap to
    // degrade into — unlike the anonymous door, which attaches the page.
    await refusedWith(() => keepSite(id, profileId), "at_kept_limit");

    assert.deepEqual(await readSite(id), before, "a refused keep writes nothing");
    assert.equal(await keptCount(profileId), FREE_LIMIT);
  },
);

test(
  "AC13 — two concurrent OWNER keeps one slot short: exactly one is kept, the other is at_kept_limit",
  { skip: skipLive },
  async () => {
    const { keepSite } = await import("./keep");
    const { StudioRefusal } = await import("./studio-refusal");

    // Repeated, because a race that is merely usually lost proves nothing. Each
    // `keepSite` opens its own transaction; `lockOwner` is what serialises them.
    for (let round = 0; round < 3; round++) {
      const profileId = await makeProfile();
      await fillKept(profileId, FREE_LIMIT - 1);
      const a = await makeSite({ ownerId: profileId });
      const b = await makeSite({ ownerId: profileId });
      const before = { [a.id]: await readSite(a.id), [b.id]: await readSite(b.id) };

      const settled = await Promise.allSettled([keepSite(a.id, profileId), keepSite(b.id, profileId)]);

      const won = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
      const lost = settled.flatMap((s) => (s.status === "rejected" ? [s.reason as unknown] : []));
      assert.equal(won.length, 1, `round ${round}: exactly one keep succeeds`);
      assert.equal(won[0]!.outcome, "kept");
      assert.deepEqual(won[0]!.quota, { limit: FREE_LIMIT, used: FREE_LIMIT, remaining: 0 });
      assert.equal(lost.length, 1, `round ${round}: and exactly one is refused`);
      assert.ok(lost[0] instanceof StudioRefusal && lost[0].code === "at_kept_limit", String(lost[0]));

      assert.equal(await keptCount(profileId), FREE_LIMIT, `round ${round}: never one over`);
      const loser = won[0]!.siteId === a.id ? b.id : a.id;
      assert.deepEqual(await readSite(loser), before[loser], "the loser is the draft it was");
    }
  },
);

test(
  "owner LATE KEEP inside grace: live again, clocks cleared, and the manifest written after commit",
  { skip: skipStores },
  async () => {
    const { keepSite } = await import("./keep");
    const profileId = await makeProfile();
    const site = await makeSite(expiredInGrace(profileId));
    createdManifests.add(site.slug);
    const before = await readSite(site.id);

    const result = await keepSite(site.id, profileId);

    assert.equal(result.outcome, "kept");
    assert.equal(result.restored, true, "the result says the page is back online");
    assert.deepEqual(result.quota, { limit: FREE_LIMIT, used: 1, remaining: FREE_LIMIT - 1 });

    const row = await readSite(site.id);
    assert.equal(row.status, "live", "the late keep flips the status back");
    assert.equal(row.expiresAt, null);
    assert.equal(row.purgeAfter, null);
    assert.ok(row.updatedAt > before.updatedAt, "updated_at moves");

    // The manifest, through `writeManifest`: the pointer is written before KV,
    // with the row's own version and region, owned by the keeper.
    const pointer = await pointerFor(site.slug);
    assert.ok(pointer, "a late keep must write the manifest — the edge still says gone otherwise");
    assert.deepEqual(pointer, {
      siteId: site.id,
      versionId: site.versionId,
      status: "live",
      region: "auto",
      ownerId: profileId,
      updatedAt: pointer.updatedAt,
    });
  },
);

test(
  "owner late keep at the cap: at_kept_limit, still expired, and no manifest written",
  { skip: skipStores },
  async () => {
    const { keepSite } = await import("./keep");
    const profileId = await makeProfile();
    await fillKept(profileId, FREE_LIMIT);
    const site = await makeSite(expiredInGrace(profileId));
    const before = await readSite(site.id);

    await refusedWith(() => keepSite(site.id, profileId), "at_kept_limit");

    assert.deepEqual(await readSite(site.id), before, "refused before any write");
    assert.equal(await pointerFor(site.slug), null, "and nothing reached the store");
  },
);

test(
  "the ordinary keep is Postgres-only: no manifest is written for a live draft",
  { skip: skipStores },
  async () => {
    const { keepSite } = await import("./keep");
    const profileId = await makeProfile();
    const site = await makeSite({ ownerId: profileId, withVersion: true });

    const result = await keepSite(site.id, profileId);

    assert.equal(result.outcome, "kept");
    assert.equal(result.restored, false);
    // `writeManifest` writes the pointer BEFORE KV, so no pointer for a slug
    // that was never published is proof no manifest write and no purge happened.
    assert.equal(await pointerFor(site.slug), null);
  },
);

test(
  "the anonymous door is shut by default: expectAnonymous omitted refuses an unowned row",
  { skip: skipLive },
  async () => {
    const { keepSite, SiteNotFoundError } = await import("./keep");
    const profileId = await makeProfile();
    const site = await makeSite();

    await assert.rejects(() => keepSite(site.id, profileId), SiteNotFoundError);
    assert.equal((await readSite(site.id)).ownerId, null);
  },
);

test(
  "keeping an already-kept page is a no-op success, not an error",
  { skip: skipLive },
  async () => {
    const { keepSite } = await import("./keep");
    const profileId = await makeProfile();
    const site = await makeSite();

    await keepSite(site.id, profileId, { expectAnonymous: true });
    const firstClaim = stamp((await readSite(site.id)).claimedAt);

    // The reminder-email link and a double-submit both land here.
    const again = await keepSite(site.id, profileId, { expectAnonymous: true });
    assert.equal(again.outcome, "kept");
    assert.deepEqual(again.quota, { limit: FREE_LIMIT, used: 1, remaining: FREE_LIMIT - 1 });

    const row = await readSite(site.id);
    assert.equal(
      stamp(row.claimedAt).getTime(),
      firstClaim.getTime(),
      "claimed_at records the FIRST keep and is never restamped",
    );
    assert.equal(await keptCount(profileId), 1);
  },
);

test(
  "anonymous door at cap: the page is owned but keeps its clocks — never an error, never a no-op",
  { skip: skipLive },
  async () => {
    const { keepSite } = await import("./keep");
    const profileId = await makeProfile();
    await fillKept(profileId, FREE_LIMIT);
    const site = await makeSite();
    const before = await readSite(site.id);

    const result = await keepSite(site.id, profileId, { expectAnonymous: true });

    assert.equal(result.outcome, "owned_draft");
    assert.deepEqual(result.quota, {
      limit: FREE_LIMIT,
      used: FREE_LIMIT,
      remaining: 0,
    });
    assert.equal(
      result.outcome === "owned_draft" && result.expiresAt,
      stamp(before.expiresAt).toISOString(),
    );

    const row = await readSite(site.id);
    assert.equal(row.ownerId, profileId, "owned even at cap");
    assert.equal(row.anonTokenHash, null, "the token still dies");
    assert.ok(row.claimedAt instanceof Date);
    assert.equal(
      stamp(row.expiresAt).getTime(),
      stamp(before.expiresAt).getTime(),
      "the clock is retained, not reset",
    );
    assert.equal(
      stamp(row.purgeAfter).getTime(),
      stamp(before.purgeAfter).getTime(),
    );
    assert.equal(await keptCount(profileId), FREE_LIMIT, "still exactly the cap");
  },
);

test(
  "anonymous door: two concurrent keeps one slot short produce exactly one kept page, never one too many",
  { skip: skipLive },
  async () => {
    const { keepSite } = await import("./keep");

    // REPEATED, because a race that is merely usually lost proves nothing. With
    // the owner lock removed from `keepSite`, this drill fails within a handful
    // of rounds — both transactions count `limit − 1` and both keep, and the
    // account ends one over its limit. That is exactly the bug the lock exists
    // to stop.
    for (let round = 0; round < 3; round++) {
      const profileId = await makeProfile();
      await fillKept(profileId, FREE_LIMIT - 1);
      const a = await makeSite();
      const b = await makeSite();

      const [first, second] = await Promise.all([
        keepSite(a.id, profileId, { expectAnonymous: true }),
        keepSite(b.id, profileId, { expectAnonymous: true }),
      ]);

      assert.deepEqual(
        [first.outcome, second.outcome].sort(),
        ["kept", "owned_draft"],
        "the loser degrades to an owned draft — it does not fail and it is not lost",
      );
      assert.equal(await keptCount(profileId), FREE_LIMIT, `round ${round}`);

      // Both pages are owned either way; only the clock distinguishes them.
      for (const site of [a, b]) {
        const row = await readSite(site.id);
        assert.equal(row.ownerId, profileId);
        assert.equal(row.anonTokenHash, null);
      }
    }
  },
);

test(
  "demote sets a FRESH clock from the shared constants and keeps the page serving",
  { skip: skipLive },
  async () => {
    const { demoteSite } = await import("./keep");
    const profileId = await makeProfile();
    const { id: siteId } = await makeSite({ ownerId: profileId, kept: true });
    const claimedBefore = stamp((await readSite(siteId)).claimedAt);

    const at = Date.now();
    const result = await demoteSite(siteId, profileId);

    const expiresAt = new Date(result.expiresAt);
    const purgeAfter = new Date(result.purgeAfter);
    assert.ok(
      Math.abs(expiresAt.getTime() - at - DRAFT_TTL_DAYS * MS_PER_DAY) < 60_000,
      "a fresh DRAFT_TTL_DAYS clock",
    );
    assert.equal(
      purgeAfter.getTime() - expiresAt.getTime(),
      DRAFT_GRACE_DAYS * MS_PER_DAY,
    );
    assert.deepEqual(result.quota, { limit: FREE_LIMIT, used: 0, remaining: FREE_LIMIT });

    const row = await readSite(siteId);
    assert.equal(row.status, "live", "demote never stops the page serving");
    assert.equal(row.ownerId, profileId, "a demoted page is an OWNED draft");
    assert.equal(
      stamp(row.claimedAt).getTime(),
      claimedBefore.getTime(),
      "claimed_at survives a demote",
    );
    assert.equal(row.slug, result.slug, "the slug never moves");
  },
);

test(
  "demote then immediate regret: keeping again is allowed with no cooldown",
  { skip: skipLive },
  async () => {
    const { demoteSite, keepSite } = await import("./keep");
    const profileId = await makeProfile();
    const { id: siteId } = await makeSite({ ownerId: profileId, kept: true });

    await demoteSite(siteId, profileId);
    const again = await keepSite(siteId, profileId);

    assert.equal(again.outcome, "kept");
    const row = await readSite(siteId);
    assert.equal(row.expiresAt, null);
    assert.equal(row.purgeAfter, null);
    assert.equal(await keptCount(profileId), 1);
  },
);

test(
  "demote only a kept live page: a draft or a flagged kept page is not_allowed_in_status, an ended one not found",
  { skip: skipLive },
  async () => {
    const { demoteSite, SiteNotFoundError } = await import("./keep");
    const profileId = await makeProfile();

    // A draft already has a clock; a second one would silently move its deadline.
    const refused = [
      await makeSite({ ownerId: profileId }),
      await makeSite(expiredInGrace(profileId)),
      await makeSite({ ownerId: profileId, kept: true, status: "under_review" }),
      await makeSite({ ownerId: profileId, kept: true, status: "quarantined" }),
    ];
    for (const { id } of refused) {
      const before = await readSite(id);
      await refusedWith(() => demoteSite(id, profileId), "not_allowed_in_status");
      assert.deepEqual(await readSite(id), before, `${before.status} must be untouched`);
    }

    for (const status of ["archived", "removed"] as const) {
      const { id } = await makeSite({ ownerId: profileId, kept: true, status });
      const before = await readSite(id);
      await assert.rejects(() => demoteSite(id, profileId), SiteNotFoundError);
      assert.deepEqual(await readSite(id), before);
    }
  },
);

test(
  "AC14 + AC37 — demote keeps name_kind, slug and listed_public; the Explore flag survives demote → keep",
  { skip: skipLive },
  async () => {
    const { demoteSite, keepSite } = await import("./keep");
    const db = await client();
    const { sites } = await schema();
    const { eq } = await import("drizzle-orm");
    const profileId = await makeProfile();
    const { id } = await makeSite({ ownerId: profileId, kept: true });
    // A chosen name and the Explore opt-in: exactly the two things an owner set
    // on purpose, which a demote must not quietly take back (D3, D12).
    await db.update(sites).set({ nameKind: "chosen", listedPublic: true }).where(eq(sites.id, id));
    const before = await readSite(id);

    await demoteSite(id, profileId);
    const demoted = await readSite(id);
    assert.ok(demoted.expiresAt instanceof Date, "precondition: it is a draft now");
    assert.equal(demoted.nameKind, "chosen", "AC14: name_kind untouched");
    assert.equal(demoted.slug, before.slug, "AC14: slug untouched");
    assert.equal(demoted.listedPublic, true, "AC14: listed_public untouched");

    await keepSite(id, profileId);
    const kept = await readSite(id);
    assert.equal(kept.expiresAt, null);
    assert.equal(kept.listedPublic, true, "AC37: the Explore flag survives demote → keep");
    assert.equal(kept.nameKind, "chosen");
    assert.equal(kept.slug, before.slug);
  },
);

test(
  "every successful keep, demote and swap moves sites.updated_at",
  { skip: skipLive },
  async () => {
    const { demoteSite, keepSite, swapKept } = await import("./keep");
    const profileId = await makeProfile();
    const draft = await makeSite({ ownerId: profileId });
    const kept = await makeSite({ ownerId: profileId, kept: true });

    // Every drill row is inserted with `updated_at` a minute in the past, so a
    // write that moved it is strictly later than the value read before it.
    const moved = async (id: string, act: () => Promise<unknown>, verb: string) => {
      const before = (await readSite(id)).updatedAt;
      await act();
      assert.ok((await readSite(id)).updatedAt > before, `${verb} must move updated_at`);
    };

    await moved(draft.id, () => keepSite(draft.id, profileId), "keep");
    await moved(draft.id, () => demoteSite(draft.id, profileId), "demote");

    const kBefore = (await readSite(kept.id)).updatedAt;
    const dBefore = (await readSite(draft.id)).updatedAt;
    await swapKept(kept.id, draft.id, profileId);
    assert.ok((await readSite(kept.id)).updatedAt > kBefore, "swap moves the demoted half");
    assert.ok((await readSite(draft.id)).updatedAt > dBefore, "swap moves the kept half");
  },
);

test(
  "swap is atomic: an injected failure between the halves leaves the cap exactly intact",
  { skip: skipLive },
  async () => {
    const { SiteNotFoundError, swapKept } = await import("./keep");
    const profileId = await makeProfile();
    const { id: demoteTarget } = await makeSite({ ownerId: profileId, kept: true });
    await fillKept(profileId, FREE_LIMIT - 1);
    const before = await readSite(demoteTarget);

    // The injected failure is real, not simulated: the second half names a site
    // that does not exist, so `keepSite` throws after `demoteSite` has already
    // written inside the transaction.
    await assert.rejects(
      () => swapKept(demoteTarget, crypto.randomUUID(), profileId),
      SiteNotFoundError,
    );

    const rolledBack = await readSite(demoteTarget);
    assert.equal(rolledBack.expiresAt, null, "the demote half rolled back");
    assert.equal(
      rolledBack.updatedAt.getTime(),
      before.updatedAt.getTime(),
      "not one column survived the rollback",
    );
    assert.equal(
      await keptCount(profileId),
      FREE_LIMIT,
      "never one short, never one over — exactly the cap",
    );
  },
);

test(
  "swap at cap: A is demoted and B is kept in one transaction",
  { skip: skipLive },
  async () => {
    const { keepSite, swapKept } = await import("./keep");
    const profileId = await makeProfile();
    const { id: demoteTarget } = await makeSite({ ownerId: profileId, kept: true });
    await fillKept(profileId, FREE_LIMIT - 1);

    // B arrives the way it really does: kept at cap, so it landed owned_draft.
    const b = await makeSite();
    const parked = await keepSite(b.id, profileId, { expectAnonymous: true });
    assert.equal(parked.outcome, "owned_draft");

    const result = await swapKept(demoteTarget, b.id, profileId);

    assert.equal(result.kept.outcome, "kept");
    assert.equal(result.kept.siteId, b.id);
    assert.equal(result.demoted.siteId, demoteTarget);
    assert.deepEqual(result.demoted.quota, result.kept.quota, "both halves agree");
    assert.deepEqual(result.kept.quota, {
      limit: FREE_LIMIT,
      used: FREE_LIMIT,
      remaining: 0,
    });

    const demoted = await readSite(demoteTarget);
    assert.ok(demoted.expiresAt instanceof Date, "A is back on a clock");
    assert.equal(demoted.status, "live", "and still serving");
    const promoted = await readSite(b.id);
    assert.equal(promoted.expiresAt, null);
    assert.equal(promoted.purgeAfter, null);
    assert.equal(await keptCount(profileId), FREE_LIMIT);
  },
);

test(
  "AC12 — swap at cap with an EXPIRED-in-grace draft: B is restored and kept, A gets a fresh clock",
  { skip: skipStores },
  async () => {
    const { swapKept } = await import("./keep");
    const profileId = await makeProfile();
    const outgoing = await makeSite({ ownerId: profileId, kept: true });
    await fillKept(profileId, FREE_LIMIT - 1);
    const b = await makeSite(expiredInGrace(profileId));
    createdManifests.add(b.slug);

    const at = Date.now();
    const result = await swapKept(outgoing.id, b.id, profileId);

    assert.equal(result.kept.siteId, b.id);
    assert.deepEqual(result.kept.quota, { limit: FREE_LIMIT, used: FREE_LIMIT, remaining: 0 });
    assert.deepEqual(result.demoted.quota, result.kept.quota, "both halves agree");

    const restored = await readSite(b.id);
    assert.equal(restored.status, "live", "B is back to live inside the same swap");
    assert.equal(restored.expiresAt, null);
    assert.equal(restored.purgeAfter, null);
    const pointer = await pointerFor(b.slug);
    assert.ok(pointer, "and its manifest was written after the swap committed");
    assert.equal(pointer.versionId, b.versionId);
    assert.equal(pointer.status, "live");

    const demoted = await readSite(outgoing.id);
    assert.ok(
      Math.abs(stamp(demoted.expiresAt).getTime() - at - DRAFT_TTL_DAYS * MS_PER_DAY) < 60_000,
      "A has a FRESH DRAFT_TTL_DAYS clock",
    );
    assert.equal(await keptCount(profileId), FREE_LIMIT);
  },
);

test(
  "swap refuses a draft as A and a kept page as B with not_allowed_in_status — and rolls both back",
  { skip: skipLive },
  async () => {
    const { swapKept } = await import("./keep");
    const profileId = await makeProfile();
    const keptA = await makeSite({ ownerId: profileId, kept: true });
    const keptB = await makeSite({ ownerId: profileId, kept: true });
    const draft = await makeSite({ ownerId: profileId });
    const flagged = await makeSite({ ownerId: profileId, kept: true, status: "quarantined" });

    const cases: [string, string, string][] = [
      // A must be a kept `live` page: demoting a draft frees nothing.
      [draft.id, keptA.id, "a draft as the demote side"],
      [flagged.id, draft.id, "a flagged page as the demote side"],
      // B must be a draft: keeping a kept page would demote A for nothing.
      [keptA.id, keptB.id, "a kept page as the keep side"],
    ];
    for (const [demoteId, keepId, label] of cases) {
      const before = [await readSite(demoteId), await readSite(keepId)];
      await refusedWith(() => swapKept(demoteId, keepId, profileId), "not_allowed_in_status");
      assert.deepEqual(
        [await readSite(demoteId), await readSite(keepId)],
        before,
        `${label}: neither row moved`,
      );
    }
  },
);

test(
  "THE DRIFT ASSERTION: keptQuotaFor and keepSite's own count agree across every status",
  { skip: skipLive },
  async () => {
    const { keepSite, keptQuotaFor } = await import("./keep");
    const profileId = await makeProfile();

    // The mix that separates a correct predicate from a plausible one. The
    // archived and removed rows are OWNED and CLOCKLESS — indistinguishable from
    // a kept page to anything that drops the status clause — and hold no slot.
    // The quarantined and under-review ones are flagged, not deleted, and STILL
    // hold theirs: freeing it would leave the account over its limit the moment
    // the review cleared the page.
    await fillKept(profileId, FREE_LIMIT - 3);
    await makeSite({ ownerId: profileId, kept: false });
    await makeSite({ ownerId: profileId, kept: false });
    await makeSite({ ownerId: profileId, kept: true, status: "archived" });
    await makeSite({ ownerId: profileId, kept: true, status: "removed" });
    await makeSite({ ownerId: profileId, kept: true, status: "quarantined" });
    await makeSite({ ownerId: profileId, kept: true, status: "under_review" });

    const quota = await keptQuotaFor(profileId);
    assert.deepEqual(quota, {
      limit: FREE_LIMIT,
      used: FREE_LIMIT - 1,
      remaining: 1,
    });
    assert.equal(
      quota.used,
      await keptCount(profileId),
      "the quota and the predicate count the same rows",
    );

    // And the enforcer agrees: keeping one more must land `kept` (the ended rows
    // hold no slot), and only then is the account full.
    const site = await makeSite();
    const result = await keepSite(site.id, profileId, { expectAnonymous: true });
    assert.equal(result.outcome, "kept");
    assert.deepEqual(
      result.quota,
      await keptQuotaFor(profileId),
      "keepSite's quota and keptQuotaFor's are the same number, from the same predicate",
    );
    assert.deepEqual(result.quota, {
      limit: FREE_LIMIT,
      used: FREE_LIMIT,
      remaining: 0,
    });
  },
);

test(
  "keptQuotaFor composes inside the caller's transaction rather than opening a second one",
  { skip: skipLive },
  async () => {
    const { demoteSite, keptQuotaFor } = await import("./keep");
    const db = await client();
    const profileId = await makeProfile();
    const site = await makeSite({ ownerId: profileId, kept: true });

    // Inside `lockOwner`'s serialisation point, the quota must reflect writes
    // this transaction has made and not yet committed. A `keptQuotaFor` that
    // opened its own connection would read the pre-demote snapshot and report 1
    // — which is how a cap decision would be made against stale state.
    await db.transaction(async (tx) => {
      const before = await keptQuotaFor(profileId, tx);
      assert.equal(before.used, 1);

      await demoteSite(site.id, profileId, { tx });

      const inside = await keptQuotaFor(profileId, tx);
      assert.equal(inside.used, 0, "the uncommitted demote is visible to the same transaction");
      assert.equal(inside.remaining, FREE_LIMIT);
    });

    assert.equal((await keptQuotaFor(profileId)).used, 0, "and it survives the commit");
  },
);

test(
  "the cap is the account's PLAN's: a premium account past the free limit still keeps, and every quota says so",
  { skip: skipLive },
  async () => {
    const { demoteSite, keepSite, keptQuotaFor } = await import("./keep");
    const premium = limitsFor("premium").keptPages;
    assert.ok(premium > FREE_LIMIT, "precondition: the premium limit is the larger one");

    // Exactly the free limit already kept — where a free account is full.
    const profileId = await makeProfile("premium");
    await fillKept(profileId, FREE_LIMIT);
    const site = await makeSite();

    const result = await keepSite(site.id, profileId, { expectAnonymous: true });
    assert.equal(result.outcome, "kept", "the plan is read, not the free alias");
    assert.deepEqual(result.quota, {
      limit: premium,
      used: FREE_LIMIT + 1,
      remaining: premium - FREE_LIMIT - 1,
    });
    assert.deepEqual(await keptQuotaFor(profileId), result.quota, "the read agrees with the decision");

    const demoted = await demoteSite(site.id, profileId);
    assert.equal(demoted.quota.limit, premium, "demote reports the plan's limit too");
  },
);

test(
  "cross-owner and non-existent are one indistinguishable not-found on every primitive",
  { skip: skipLive },
  async () => {
    const { demoteSite, keepSite, SiteNotFoundError, swapKept } = await import("./keep");
    const owner = await makeProfile();
    const stranger = await makeProfile();
    const { id: mine } = await makeSite({ ownerId: owner, kept: true });
    const ghost = crypto.randomUUID();

    const messages = new Set<string>();
    for (const siteId of [mine, ghost]) {
      for (const call of [
        () => keepSite(siteId, stranger),
        () => keepSite(siteId, stranger, { expectAnonymous: true }),
        () => demoteSite(siteId, stranger),
        () => swapKept(siteId, siteId, stranger),
      ]) {
        await assert.rejects(call, (err: Error) => {
          assert.ok(err instanceof SiteNotFoundError);
          messages.add(err.message.replace(mine, "<id>").replace(ghost, "<id>"));
          return true;
        });
      }
    }

    assert.equal(
      messages.size,
      1,
      "an existing site owned by someone else and a site that never existed answer identically",
    );
    // The stranger changed nothing.
    const row = await readSite(mine);
    assert.equal(row.ownerId, owner);
    assert.equal(row.expiresAt, null);
  },
);
