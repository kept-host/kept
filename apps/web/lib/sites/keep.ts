/**
 * Keep, demote and swap — the three site-lifecycle primitives E05 is about.
 *
 * ⚠️ KEEPING IS A POSTGRES WRITE, NOT A PUBLISH. The manifest the Worker reads
 * is `{ siteId, versionId, status, region, ownerId, updatedAt }`. Keeping
 * changes exactly one of those — `ownerId`, from null to a uuid. `status` stays
 * `live`, the slug stays, `versionId` stays, and R2 is untouched because the
 * object is keyed by `siteId`. So the ordinary keep does **not** call
 * `writeManifest`, does **not** purge, and does **not** pay the 125-second
 * re-purge cost. Writing the manifest anyway "for consistency" is a real
 * regression: it burns cache-purge quota and adds a failure mode to a flow that
 * currently has none.
 *
 * The manifest is therefore knowingly STALE on `ownerId` for every kept page,
 * and that is accepted rather than fixed. Nothing in `apps/edge` reads
 * `ownerId` — E03 shipped it as forward-looking metadata for E11 region
 * routing, not as serving input. If a future epic starts reading it, THAT epic
 * re-syncs. E05 does not pre-pay for it.
 *
 * Exactly one branch breaks the Postgres-only rule — the late keep of an
 * `expired` row inside the 30-day grace, where the manifest was removed and
 * bringing the page back means going through `lib/storage/manifest.ts` again.
 * That branch belongs to the route handler (task 008), which composes the store
 * restore and the status flip around `keepSite`. **There are no store calls in
 * this module at all**: no `writeManifest`, no `removeManifest`, no R2, no
 * purge. Keep it that way.
 *
 * THE CAP IS A BRANCH, NOT A GUARD CLAUSE. At `KEPT_PAGE_LIMIT` the page still
 * gets `owner_id`, still loses its `anon_token_hash` and still shows up in the
 * dashboard — it simply keeps its clocks. That is why `keepSite` returns a
 * discriminated `KeepResult` instead of throwing.
 */
import {
  KEPT_PAGE_LIMIT,
  type DemoteResult,
  type KeepResult,
  type KeptQuota,
  type SwapResult,
} from "@kept/shared";
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../db";
import { profiles, sites } from "../db/schema";
// The single definition of the draft clock arithmetic, reused rather than
// retyped: `now + DRAFT_TTL_DAYS`, then `+ DRAFT_GRACE_DAYS`, both from
// `@kept/shared`. This is an import of a pure function — the publish pipeline's
// store helpers resolve their environment lazily inside their own calls, so
// nothing here reaches R2, KV or the purge endpoint.
import { draftClocks } from "../publish/pipeline";

/** The transaction handle Drizzle hands `db.transaction`'s callback. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A site that does not exist, is not owned by this profile, or is not in the
 * ownership state the caller declared.
 *
 * ONE SHAPE FOR ALL THREE. "You don't own this" is an existence oracle: it
 * tells a caller that a site id is real, which is exactly what a probe wants.
 * Route handlers map this to a 404 and nothing else.
 */
export class SiteNotFoundError extends Error {
  constructor(siteId: string) {
    super(`No site ${siteId} is available to this profile.`);
    this.name = "SiteNotFoundError";
  }
}

export interface KeepOptions {
  /**
   * Declare the ownership state the caller expects, explicitly — never by
   * convention.
   *
   * `false` (default): the row must already be owned by `profileId`. This is
   * the signed-in owner path (task 010).
   *
   * `true`: the row may be anonymous (`owner_id IS NULL`) — the
   * anonymous→owned door, and the bearer-token keep route (task 008) is the
   * only caller allowed through it. A row already owned by *this same* profile
   * is still accepted, so a double-submit of the keep link is a no-op success
   * rather than a 404.
   */
  expectAnonymous?: boolean;
  /** Compose inside an existing transaction (`swapKept`). Public callers pass none. */
  tx?: Tx;
}

/** Run `fn` in `tx` if one was supplied, otherwise in a fresh transaction. */
function inTransaction<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return tx ? fn(tx) : db.transaction(fn);
}

/**
 * THE SERIALISATION POINT for every cap decision: an exclusive lock on the
 * owner's `profiles` row, taken before the count and held to commit.
 *
 * Locking the owner's *kept sites* instead is the bug that looks like a fix.
 * `SELECT … FROM sites WHERE owner_id = ? AND expires_at IS NULL FOR UPDATE`
 * locks the rows that qualify *now*; a concurrent transaction keeping a
 * different page makes that page qualify, and under READ COMMITTED a phantom
 * row is not in the second transaction's lock set. Two tabs at 2/3 would then
 * both count 2 and both keep, producing a fourth kept page. Serialising on the
 * owner has no phantom: the second transaction blocks here, and its count
 * statement afterwards takes a fresh snapshot that includes the first keep.
 */
async function lockOwner(tx: Tx, profileId: string): Promise<void> {
  const [row] = await tx
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.id, profileId))
    .for("update");
  if (!row) {
    throw new Error(
      `No profile ${profileId}. A keep/demote takes a profile id that a session already resolved.`,
    );
  }
}

/**
 * How many pages this profile currently keeps.
 *
 * `owner_id = ? AND expires_at IS NULL AND status = 'live'` — the definition of
 * kept-ness, and the only one. `claimed_at` is a historical stamp that survives
 * a demote and must never be read to answer this question.
 */
async function countKept(tx: Tx, profileId: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(sites)
    .where(
      and(eq(sites.ownerId, profileId), isNull(sites.expiresAt), eq(sites.status, "live")),
    );
  return row?.count ?? 0;
}

function quotaOf(used: number): KeptQuota {
  return {
    limit: KEPT_PAGE_LIMIT,
    used,
    remaining: Math.max(0, KEPT_PAGE_LIMIT - used),
  };
}

/** The columns every primitive below reads, locked for the read-modify-write. */
async function lockSite(tx: Tx, siteId: string) {
  const [site] = await tx
    .select({
      id: sites.id,
      slug: sites.slug,
      status: sites.status,
      ownerId: sites.ownerId,
      expiresAt: sites.expiresAt,
      purgeAfter: sites.purgeAfter,
      claimedAt: sites.claimedAt,
    })
    .from(sites)
    .where(eq(sites.id, siteId))
    .for("update");
  return site ?? null;
}

/**
 * Attach a page to an account and, if the account is under its cap, take the
 * clock off it.
 *
 * `status` IS DELIBERATELY UNTOUCHED. An `expired` row keeps its status here;
 * flipping it back to `live` is half of the store restore, and the store
 * restore is task 008's — doing it here would put half a store operation in a
 * module that must contain none.
 */
export async function keepSite(
  siteId: string,
  profileId: string,
  options: KeepOptions = {},
): Promise<KeepResult> {
  const { expectAnonymous = false, tx } = options;

  return inTransaction(tx, async (trx) => {
    await lockOwner(trx, profileId);

    const site = await lockSite(trx, siteId);
    if (!site) throw new SiteNotFoundError(siteId);

    const ownershipOk = expectAnonymous
      ? site.ownerId === null || site.ownerId === profileId
      : site.ownerId === profileId;
    if (!ownershipOk) throw new SiteNotFoundError(siteId);

    // Already kept: the reminder-email link and a double-submit both land here.
    // A no-op success, not an error and not a second write.
    if (site.ownerId === profileId && site.expiresAt === null && site.status === "live") {
      return {
        outcome: "kept",
        siteId: site.id,
        slug: site.slug,
        quota: quotaOf(await countKept(trx, profileId)),
      };
    }

    const now = new Date();
    // Set on the FIRST keep and never restamped: `claimed_at` records when the
    // page stopped being anonymous, not whether it is kept right now.
    const claimedAt = site.claimedAt ?? now;
    const used = await countKept(trx, profileId);

    if (used < KEPT_PAGE_LIMIT) {
      await trx
        .update(sites)
        .set({
          ownerId: profileId,
          expiresAt: null,
          purgeAfter: null,
          // Two authorities on one page is a bug: the bearer token dies the
          // moment an account owns the row.
          anonTokenHash: null,
          claimedAt,
          updatedAt: now,
        })
        .where(eq(sites.id, siteId));

      return {
        outcome: "kept",
        siteId: site.id,
        slug: site.slug,
        quota: quotaOf(used + 1),
      };
    }

    // At cap. The page is owned, the token is dead, the clocks are RETAINED.
    // Never a throw, never a 4xx, never a silent no-op — the caller renders a
    // countdown and a swap prompt.
    //
    // A row with no clock reaching this branch is a data anomaly (every
    // anonymous publish sets both), and an `owned_draft` is not expressible
    // without one, so it gets a fresh draft clock rather than a null result.
    const clocks =
      site.expiresAt && site.purgeAfter
        ? { expiresAt: site.expiresAt, purgeAfter: site.purgeAfter }
        : draftClocks(now);

    await trx
      .update(sites)
      .set({
        ownerId: profileId,
        expiresAt: clocks.expiresAt,
        purgeAfter: clocks.purgeAfter,
        anonTokenHash: null,
        claimedAt,
        updatedAt: now,
      })
      .where(eq(sites.id, siteId));

    return {
      outcome: "owned_draft",
      siteId: site.id,
      slug: site.slug,
      quota: quotaOf(used),
      expiresAt: clocks.expiresAt.toISOString(),
      purgeAfter: clocks.purgeAfter.toISOString(),
    };
  });
}

export interface DemoteOptions {
  /** Compose inside an existing transaction (`swapKept`). Public callers pass none. */
  tx?: Tx;
}

/**
 * Put a kept page back on a clock, freeing a slot.
 *
 * ARCHIVE, DON'T DELETE: demote removes nothing. `status` stays `live`, the
 * slug stays, the manifest stays, R2 stays — the page keeps serving at the same
 * URL, it just has a deadline again. `owner_id` and `claimed_at` are both
 * retained: a demoted page is an *owned* draft.
 *
 * The clock is FRESH, not resumed. There is nothing to resume — keeping nulled
 * the old one — and no cooldown: demote → immediate regret → `keepSite` again
 * simply clears it.
 */
export async function demoteSite(
  siteId: string,
  profileId: string,
  options: DemoteOptions = {},
): Promise<DemoteResult> {
  return inTransaction(options.tx, async (trx) => {
    await lockOwner(trx, profileId);

    const site = await lockSite(trx, siteId);
    if (!site || site.ownerId !== profileId) throw new SiteNotFoundError(siteId);

    const now = new Date();
    const { expiresAt, purgeAfter } = draftClocks(now);

    await trx
      .update(sites)
      .set({ expiresAt, purgeAfter, updatedAt: now })
      .where(eq(sites.id, siteId));

    return {
      siteId: site.id,
      slug: site.slug,
      expiresAt: expiresAt.toISOString(),
      purgeAfter: purgeAfter.toISOString(),
      quota: quotaOf(await countKept(trx, profileId)),
    };
  });
}

/**
 * Demote one page and keep another in ONE transaction.
 *
 * The atomicity is the feature: a partial swap would leave the account either
 * a slot short or a page over the cap, and the second is the one that matters.
 * Because the demote has committed *within this transaction* by the time
 * `keepSite` counts, the cap check sees the freed slot and B lands `kept` by
 * construction — an `owned_draft` here would mean the demote did not free
 * anything, so it is asserted rather than returned.
 */
export async function swapKept(
  demoteSiteId: string,
  keepSiteId: string,
  profileId: string,
): Promise<SwapResult> {
  return db.transaction(async (tx) => {
    const demoted = await demoteSite(demoteSiteId, profileId, { tx });
    const kept = await keepSite(keepSiteId, profileId, { tx });

    if (kept.outcome !== "kept") {
      throw new Error(
        `swapKept: demoting ${demoteSiteId} did not free a slot — keeping ${keepSiteId} landed "${kept.outcome}". Rolling back.`,
      );
    }

    // Both halves report the SAME post-swap quota. `demoted.quota` was measured
    // between the two writes, when the account was one page short.
    return { demoted: { ...demoted, quota: kept.quota }, kept };
  });
}
