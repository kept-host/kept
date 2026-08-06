/**
 * The keep / demote / swap drills — E05 task 007.
 *
 * NO MOCKS (project rule). Every assertion below runs against the real dev Neon
 * branch: real `user`, `profiles` and `sites` rows, real transactions, real row
 * locks. The concurrency drill in particular is only meaningful against a real
 * Postgres — it is the one that proves two tabs at 2/3 cannot both keep.
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

import { DRAFT_GRACE_DAYS, DRAFT_TTL_DAYS, KEPT_PAGE_LIMIT } from "@kept/shared";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Everything created by these drills, torn down in `after`. */
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
  await db.insert(user).values({
    id,
    name: "E05-007 drill",
    email: `e05-007-${id}@kept.invalid`,
    emailVerified: true,
  });
  await db.insert(profiles).values({ id, email: `e05-007-${id}@kept.invalid`, plan: "free" });
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
  const slug = `e05-007-${id.slice(0, 12)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DRAFT_TTL_DAYS * MS_PER_DAY);

  await db.insert(sites).values({
    id,
    slug,
    status: "live",
    region: "auto",
    ownerId,
    anonTokenHash: ownerId === null ? `e05-007-${id}` : null,
    publisherHash: "e05-007-drill",
    expiresAt: kept ? null : expiresAt,
    purgeAfter: kept ? null : new Date(expiresAt.getTime() + DRAFT_GRACE_DAYS * MS_PER_DAY),
    claimedAt: ownerId === null ? null : now,
    contentHash: "e05-007",
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

/** A `timestamp` column the drill has just asserted must be set. */
function stamp(value: Date | null): Date {
  if (!value) throw new Error("Expected a timestamp, got null.");
  return value;
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
async function fillKept(profileId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await makeSite({ ownerId: profileId, kept: true });
  }
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
    assert.deepEqual(result.quota, { limit: KEPT_PAGE_LIMIT, used: 1, remaining: 2 });

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
    assert.deepEqual(again.quota, { limit: KEPT_PAGE_LIMIT, used: 1, remaining: 2 });

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
  "at cap: the page is owned but keeps its clocks — never an error, never a no-op",
  { skip: skipLive },
  async () => {
    const { keepSite } = await import("./keep");
    const profileId = await makeProfile();
    await fillKept(profileId, KEPT_PAGE_LIMIT);
    const site = await makeSite();
    const before = await readSite(site.id);

    const result = await keepSite(site.id, profileId, { expectAnonymous: true });

    assert.equal(result.outcome, "owned_draft");
    assert.deepEqual(result.quota, {
      limit: KEPT_PAGE_LIMIT,
      used: KEPT_PAGE_LIMIT,
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
    assert.equal(await keptCount(profileId), KEPT_PAGE_LIMIT, "still exactly the cap");
  },
);

test(
  "two concurrent keeps at 2/3 produce exactly one kept page, never a fourth",
  { skip: skipLive },
  async () => {
    const { keepSite } = await import("./keep");

    // REPEATED, because a race that is merely usually lost proves nothing. With
    // the owner lock removed from `keepSite`, this drill fails within a handful
    // of rounds — both transactions count 2 and both keep, and the account ends
    // with four kept pages. That is exactly the bug the lock exists to stop.
    for (let round = 0; round < 3; round++) {
      const profileId = await makeProfile();
      await fillKept(profileId, KEPT_PAGE_LIMIT - 1);
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
      assert.equal(await keptCount(profileId), KEPT_PAGE_LIMIT, `round ${round}`);

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
    assert.deepEqual(result.quota, { limit: KEPT_PAGE_LIMIT, used: 0, remaining: 3 });

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
  "swap is atomic: an injected failure between the halves leaves the cap exactly intact",
  { skip: skipLive },
  async () => {
    const { SiteNotFoundError, swapKept } = await import("./keep");
    const profileId = await makeProfile();
    const { id: demoteTarget } = await makeSite({ ownerId: profileId, kept: true });
    await fillKept(profileId, KEPT_PAGE_LIMIT - 1);
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
      KEPT_PAGE_LIMIT,
      "never 2, never 4 — exactly the cap",
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
    await fillKept(profileId, KEPT_PAGE_LIMIT - 1);

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
      limit: KEPT_PAGE_LIMIT,
      used: KEPT_PAGE_LIMIT,
      remaining: 0,
    });

    const demoted = await readSite(demoteTarget);
    assert.ok(demoted.expiresAt instanceof Date, "A is back on a clock");
    assert.equal(demoted.status, "live", "and still serving");
    const promoted = await readSite(b.id);
    assert.equal(promoted.expiresAt, null);
    assert.equal(promoted.purgeAfter, null);
    assert.equal(await keptCount(profileId), KEPT_PAGE_LIMIT);
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
