/**
 * Keep, demote and swap — the three site-lifecycle primitives E05 is about,
 * made honest about status by E06 task 004.
 *
 * ⚠️ KEEPING A LIVE PAGE IS A POSTGRES WRITE, NOT A PUBLISH. The manifest the
 * Worker reads is `{ siteId, versionId, status, region, ownerId, updatedAt }`.
 * Keeping a `live` page changes exactly one of those — `ownerId`, from null to a
 * uuid. `status` stays `live`, the slug stays, `versionId` stays, and R2 is
 * untouched because the object is keyed by `siteId`. So the ordinary keep does
 * **not** call `writeManifest`, does **not** purge, and does **not** pay the
 * 125-second re-purge cost. Writing the manifest anyway "for consistency" is a
 * real regression: it burns cache-purge quota and adds a failure mode to a flow
 * that currently has none.
 *
 * The manifest is therefore knowingly STALE on `ownerId` for every kept page,
 * and that is accepted rather than fixed. Nothing in `apps/edge` reads
 * `ownerId` — E03 shipped it as forward-looking metadata for E11 region
 * routing, not as serving input. If a future epic starts reading it, THAT epic
 * re-syncs. E05 does not pre-pay for it.
 *
 * ── THE ONE STORE CALL: THE LATE KEEP ──────────────────────────────────────
 * An `expired` row inside its grace window (`purge_after > now()`, PRD §5.3)
 * had its manifest REMOVED when it expired, so the edge says "gone" and only a
 * KV write brings it back. Keeping it flips the row to `live` and clears its
 * clocks inside the transaction, and then — only after COMMIT —
 * `restoreManifest` writes the manifest through `writeManifest`. Postgres first:
 * the reverse order would put a page back on the internet that the database
 * still calls expired, and E07's grace sweep would take it down again underneath
 * its new owner. Both keep doors (`./anon-keep.ts`, the owner route) and the
 * swap reach that sequence through this module and nowhere else; there is no
 * other store call here, and a direct `lib/storage/kv` import is a lint error.
 *
 * ── STATUS IS DECIDED UNDER THE LOCK ───────────────────────────────────────
 * Every primitive reads the row's `status`/`purge_after` AFTER `lockOwner` and
 * the row lock, never from a pre-flight read, because E07's expiry sweep can
 * move them in between (epic Risk 7; the sweep must take the same lock).
 *
 *   archived · removed · expired past grace   → not found (edge case 13)
 *   under_review · quarantined                 → 409 not_allowed_in_status
 *   live draft · expired in grace              → keepable
 *   kept live                                  → keep is a no-op; demotable
 *
 * ── THE CAP DEPENDS ON THE DOOR ────────────────────────────────────────────
 * Through the ANONYMOUS door the cap is a branch, not a guard clause: at the
 * account's kept limit the page still gets `owner_id`, still loses its
 * `anon_token_hash` and lands an `owned_draft` that keeps a clock — attaching
 * the page IS the point of that door (E05). Through the OWNER door the page is
 * already an owned draft, so there is nothing to attach and the cap is a
 * `409 at_kept_limit` (PRD §10.2, epic Risk 6, decision #6).
 *
 * THE LIMIT IS THE PLAN'S (D1). Every cap below is `limitsFor(plan).keptPages`,
 * with `plan` read from the owner's `profiles` row — under `lockOwner` wherever a
 * cap is decided, so the plan and the count come from the same locked moment.
 * `KEPT_PAGE_LIMIT` is the free number for surfaces with no account; it is never
 * read here.
 */
import {
  limitsFor,
  type DemoteResult,
  type KeepResult,
  type KeptQuota,
  type KvManifest,
  type Plan,
  type SiteStatus,
  type SwapResult,
} from "@kept/shared";
import { and, eq, isNull, notInArray, sql, type SQL } from "drizzle-orm";

import { db, type Tx } from "../db";
import { profiles, sites } from "../db/schema";
// The single definition of the draft clock arithmetic, reused rather than
// retyped: `now + DRAFT_TTL_DAYS`, then `+ DRAFT_GRACE_DAYS`, both from
// `@kept/shared`.
import { draftClocks } from "../publish/pipeline";
import { writeManifest } from "../storage/manifest";

import { managementRefusal } from "./display";
import { StudioRefusal } from "./studio-refusal";

/**
 * A site that does not exist, is not owned by this profile, or is not in the
 * ownership state the caller declared.
 *
 * ONE SHAPE FOR ALL THREE. "You don't own this" is an existence oracle: it
 * tells a caller that a site id is real, which is exactly what a probe wants.
 * So the message is ONE constant sentence, with no id in it, and the studio
 * routes answer it as `404 not_found` byte-identically however it was reached.
 */
export const SITE_NOT_FOUND_MESSAGE =
  "No page with that id is available on this account. It may have been deleted, or the id may be wrong.";

export class SiteNotFoundError extends StudioRefusal {
  constructor(public readonly siteId: string) {
    super("not_found", SITE_NOT_FOUND_MESSAGE);
    this.name = "SiteNotFoundError";
  }
}

/**
 * The two statuses an owner can never act on again: deleted by its owner (D14)
 * or taken down (E07). They hold no slot and answer every primitive here as
 * not found. One spelling, for the SQL predicate and the row check alike.
 */
const ENDED_STATUSES = ["archived", "removed"] as const satisfies readonly SiteStatus[];

export interface KeepOptions {
  /**
   * Declare the ownership state the caller expects, explicitly — never by
   * convention.
   *
   * `false` (default): the OWNER door. The row must already be owned by
   * `profileId`, and at the kept limit the keep is refused `at_kept_limit`.
   *
   * `true`: the ANONYMOUS door. The row may be anonymous (`owner_id IS NULL`),
   * and the bearer-token keep route (`./anon-keep.ts`) is the only caller
   * allowed through it. A row already owned by *this same* profile is still
   * accepted, so a double-submit of the keep link is a no-op success rather
   * than a 404. At the kept limit the page lands `owned_draft`.
   */
  expectAnonymous?: boolean;
}

/**
 * `KeepResult`, plus the one thing the store half can tell the caller.
 *
 * `restored` is true only on the late keep: the page had expired and its
 * manifest has been written again, so it serves at the same address once more.
 * The anonymous screen says "back online" from it; the owner route's response
 * schema strips it, leaving E05's success body unchanged.
 */
export type KeepSiteResult = KeepResult & { restored: boolean };

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
 * row is not in the second transaction's lock set. Two tabs one slot short of
 * the limit would then both count the same number and both keep, producing one
 * kept page too many. Serialising on the owner has no phantom: the second
 * transaction blocks here, and its count statement afterwards takes a fresh
 * snapshot that includes the first keep.
 *
 * RETURNS THE OWNER'S PLAN, read off the row this lock holds. The cap is
 * `limitsFor(plan)`, so the plan is part of the decision and must come from the
 * same locked read as the count — never from a session object or a second
 * query outside the lock, which a concurrent plan change could make stale.
 *
 * ⚠️ EXPORTED SO THE OWNED PUBLISH SERIALISES ON THE SAME POINT (E06 task 004).
 * A signed-in publish decides kept-or-draft against the same cap, so it must
 * queue behind the same lock: two dashboard tabs one slot short that each took
 * a *different* serialisation point would both count the same and both land
 * kept, producing one kept page too many — the exact failure the paragraph above
 * describes, reached through a second door. `./publish.ts` takes this lock and
 * does its count AND its insert inside the transaction that holds it.
 */
export async function lockOwner(tx: Tx, profileId: string): Promise<Plan> {
  const [row] = await tx
    .select({ plan: profiles.plan })
    .from(profiles)
    .where(eq(profiles.id, profileId))
    .for("update");
  if (!row) throw noProfile(profileId);
  return row.plan;
}

function noProfile(profileId: string): Error {
  return new Error(
    `No profile ${profileId}. A keep/demote/publish takes a profile id that a session already resolved.`,
  );
}

/**
 * The owner's plan, read WITHOUT a lock — for `keptQuotaFor`, which is a read.
 *
 * Inside a transaction that already holds `lockOwner` (the owned publish) this
 * reads the very row that lock holds, so it cannot disagree with it; it never
 * takes a second lock. Outside one (a dashboard render) it is the plain read the
 * render wants.
 */
async function planOf(tx: Tx, profileId: string): Promise<Plan> {
  const [row] = await tx
    .select({ plan: profiles.plan })
    .from(profiles)
    .where(eq(profiles.id, profileId));
  if (!row) throw noProfile(profileId);
  return row.plan;
}

/**
 * THE DEFINITION OF KEPT-NESS, AND THE ONLY ONE.
 *
 * `owner_id = ? AND expires_at IS NULL AND status NOT IN ('archived','removed')`
 * (epic Architecture Notes). `claimed_at` is a historical stamp that survives a
 * demote and must never be read to answer this question — see the column
 * comment in `../db/schema.ts`.
 *
 * A kept page that E07 holds `under_review` or `quarantined` STILL OCCUPIES ITS
 * SLOT: a flag is not a deletion, and a quota that freed the slot would leave
 * the account over its limit the moment the review cleared it. Only the two
 * ended statuses give the slot back.
 *
 * ⚠️ EXPORTED SO IT IS NEVER RETYPED (E06 task 002). The dashboard splits the
 * kept wall from the drafts section and prints "N of {the plan's limit}" with
 * the same predicate this module counts the cap with. A second copy of the WHERE
 * clause in a query module is not cosmetic duplication: the two drift the first
 * time a status changes what counts, and then the dashboard disagrees with the
 * endpoint that enforces the cap. Compose this — do not re-spell it.
 *
 * The exclusion belongs to the *quota*, not to what a dashboard may read: a
 * page that vanishes from the wall when it is flagged is indistinguishable from
 * data loss. `lib/db/queries/dashboard.ts` reads every status and asks this
 * predicate only for the number.
 */
export function isKeptCondition(profileId: string): SQL {
  return and(
    eq(sites.ownerId, profileId),
    isNull(sites.expiresAt),
    notInArray(sites.status, [...ENDED_STATUSES]),
  ) as SQL;
}

/**
 * How many pages this profile currently keeps.
 *
 * Stays private: callers want the quota, not the arithmetic. `keptQuotaFor`
 * below is the public door, and both read `isKeptCondition`.
 */
async function countKept(tx: Tx, profileId: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(sites)
    .where(isKeptCondition(profileId));
  return row?.count ?? 0;
}

function quotaOf(used: number, plan: Plan): KeptQuota {
  const limit = limitsFor(plan).keptPages;
  return { limit, used, remaining: Math.max(0, limit - used) };
}

/**
 * The account's kept-page allowance right now — the one number every E06 surface
 * prints (dashboard header, drop-zone notice, keep button, swap chooser).
 *
 * It wraps `countKept` + `planOf` + `quotaOf` so `quotaOf`'s arithmetic — and
 * the `limitsFor(plan)` it reads — stays in exactly one place. A caller that
 * subtracts `used` from a limit of its own is the same drift `isKeptCondition`
 * exists to prevent, one level up.
 *
 * ⚠️ PASS `tx` WHEN YOU ARE ALREADY INSIDE A CAP DECISION. A quota read that
 * opens its own connection takes a *different* snapshot — outside the lock,
 * after a concurrent keep, before this transaction's own write. Composing with
 * the caller's `tx` reads inside the serialisation point and therefore agrees
 * with what the cap branch decided. Without a `tx` this opens its own read
 * transaction, which is what a server-component dashboard read wants.
 */
export function keptQuotaFor(profileId: string, tx?: Tx): Promise<KeptQuota> {
  return inTransaction(tx, async (trx) =>
    quotaOf(await countKept(trx, profileId), await planOf(trx, profileId)),
  );
}

/** The columns every primitive below reads, locked for the read-modify-write. */
async function lockSite(tx: Tx, siteId: string) {
  const [site] = await tx
    .select({
      id: sites.id,
      slug: sites.slug,
      status: sites.status,
      region: sites.region,
      currentVersionId: sites.currentVersionId,
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

type LockedSite = NonNullable<Awaited<ReturnType<typeof lockSite>>>;

/**
 * THE GRACE RULE, AND THE ONLY SPELLING OF IT: the row's `purge_after` has
 * passed, so whatever it was is E07's to collect and no longer its owner's to
 * act on. For a draft that is `expires_at + DRAFT_GRACE_DAYS` (`draftClocks`
 * writes both at publish); for an archived page, the end of its download window
 * (D14). A kept page has no `purge_after` and is never past it.
 *
 * ⚠️ IT READS THE CLOCK, NEVER `status`. No expiry sweep exists until E07, so a
 * draft whose grace ran out weeks ago still says `live` — and the home listed it
 * with a Keep button that worked. The home's read, the keep primitives below and
 * the owner's download / detail screen (`./export.ts`) all ask this one function.
 */
export function isPastGrace(site: { purgeAfter: Date | null }, now: Date): boolean {
  return site.purgeAfter !== null && site.purgeAfter <= now;
}

/**
 * Nothing left for an owner to act on: deleted, taken down, or past its grace
 * window and awaiting E07's hard delete (edge case 13) — whatever its `status`
 * says. An `expired` row with no `purge_after` cannot be shown to be inside a
 * window, so it is gone rather than guessed at.
 *
 * Answered as the SAME not-found as a page that never existed: telling an owner
 * "that page exists but is gone" through a different body is the oracle
 * `SiteNotFoundError` exists to avoid, and there is no action to offer either way.
 */
function isGone(site: LockedSite, now: Date): boolean {
  if ((ENDED_STATUSES as readonly SiteStatus[]).includes(site.status)) return true;
  return isPastGrace(site, now) || (site.status === "expired" && site.purgeAfter === null);
}

/** What a late keep still owes the edge once its transaction has committed. */
interface PendingRestore {
  slug: string;
  manifest: KvManifest;
}

/**
 * Which door a keep came through. It decides who may own the row going in and
 * what the cap does — see the module header.
 *
 * `swap` is the owner door with one more rule: its page must be a DRAFT. An
 * already-kept page on the keep side would make the swap demote the other page
 * for nothing, which costs the owner a permanent page.
 */
type KeepDoor = "anonymous" | "owner" | "swap";

const ALREADY_KEPT_MESSAGE =
  "That page is already kept. Choose a draft to keep in its place.";

const CONTENTS_MISSING_MESSAGE =
  "kept could not bring this page back — its contents are missing. Nothing was changed.";

const RESTORE_INCOMPLETE_MESSAGE =
  "This page is now on your account, but kept could not bring it back online. Nothing was lost — the page is recorded as live and will be restored.";

function atKeptLimit(plan: Plan): StudioRefusal {
  return new StudioRefusal(
    "at_kept_limit",
    `All ${limitsFor(plan).keptPages} of your kept pages are in use. Swap one out to keep this page.`,
  );
}

/**
 * The Postgres half of every keep, inside the caller's transaction.
 *
 * Returns the result and — on the late keep only — the manifest the caller must
 * write AFTER this transaction commits (`restoreManifest`). The store write is
 * never made from in here: an uncommitted row behind a live manifest is the
 * ordering bug the late keep exists to avoid.
 */
async function keepLocked(
  trx: Tx,
  siteId: string,
  profileId: string,
  door: KeepDoor,
): Promise<{ result: KeepResult; restore: PendingRestore | null }> {
  const plan = await lockOwner(trx, profileId);
  const site = await lockSite(trx, siteId);
  const now = new Date();

  const ownershipOk =
    site !== null &&
    (site.ownerId === profileId || (door === "anonymous" && site.ownerId === null));
  if (!site || !ownershipOk || isGone(site, now)) throw new SiteNotFoundError(siteId);

  // `under_review` / `quarantined`: E07's flags, which E06 renders and never
  // writes. Making a flagged page permanent is the evasion the flag exists to
  // stop. The sentence is the one the card already shows for the same state.
  const flagged = managementRefusal(site.status);
  if (flagged) throw new StudioRefusal("not_allowed_in_status", flagged);

  // Already kept: the reminder-email link and a double-submit both land here.
  // A no-op success, not an error and not a second write.
  if (site.ownerId === profileId && site.expiresAt === null && site.status === "live") {
    if (door === "swap") throw new StudioRefusal("not_allowed_in_status", ALREADY_KEPT_MESSAGE);
    return {
      result: {
        outcome: "kept",
        siteId: site.id,
        slug: site.slug,
        quota: quotaOf(await countKept(trx, profileId), plan),
      },
      restore: null,
    };
  }

  // The late keep. Decided here, under both locks, from the row as it is NOW.
  // Refused before any write: with no version there is no R2 object to point a
  // manifest at, and the row must not be marked `live` with nothing to serve.
  let restore: PendingRestore | null = null;
  if (site.status === "expired") {
    if (!site.currentVersionId) {
      throw new StudioRefusal(
        "internal_error",
        CONTENTS_MISSING_MESSAGE,
        `site ${site.id} (slug "${site.slug}") is expired with no current version — cannot restore.`,
      );
    }
    restore = {
      slug: site.slug,
      manifest: {
        siteId: site.id,
        versionId: site.currentVersionId,
        // Drafts and kept pages are both `live`; the clock lives in Postgres
        // and never in the manifest.
        status: "live",
        // From the row, never a hardcoded "auto" — an EU page must not come back
        // pointing at the wrong bucket.
        region: site.region,
        // The page is owned as of this transaction.
        ownerId: profileId,
        updatedAt: Date.now(),
      },
    };
  }

  const underCap = (await countKept(trx, profileId)) < limitsFor(plan).keptPages;
  if (!underCap && door !== "anonymous") throw atKeptLimit(plan);

  // At the cap (the anonymous door only) the page is owned and keeps a clock:
  // the one it had while that is still running, but a FRESH one for a row that
  // expired (resuming would hand back an `owned_draft` that expired before it was
  // created) or that has no clock at all (a data anomaly — every anonymous
  // publish sets both).
  const held = underCap
    ? null
    : !restore && site.expiresAt && site.purgeAfter
      ? { expiresAt: site.expiresAt, purgeAfter: site.purgeAfter }
      : draftClocks(now);

  await trx
    .update(sites)
    .set({
      ownerId: profileId,
      // A no-op on a `live` row; the late keep's flip back on an `expired` one.
      status: "live",
      expiresAt: held?.expiresAt ?? null,
      purgeAfter: held?.purgeAfter ?? null,
      // Two authorities on one page is a bug: the bearer token dies the moment
      // an account owns the row.
      anonTokenHash: null,
      // Set on the FIRST keep and never restamped: `claimed_at` records when the
      // page stopped being anonymous, not whether it is kept right now.
      claimedAt: site.claimedAt ?? now,
    })
    .where(eq(sites.id, siteId));

  // Counted again rather than `used + 1`: the quota reports the predicate's own
  // answer after the write, never arithmetic about a row it assumed counted.
  const quota = quotaOf(await countKept(trx, profileId), plan);
  const result: KeepResult = held
    ? {
        outcome: "owned_draft",
        siteId: site.id,
        slug: site.slug,
        quota,
        expiresAt: held.expiresAt.toISOString(),
        purgeAfter: held.purgeAfter.toISOString(),
      }
    : { outcome: "kept", siteId: site.id, slug: site.slug, quota };

  return { result, restore };
}

/**
 * The store half of a late keep, run only after the keep's transaction has
 * committed. A PURGE IS TWO PURGES — `writeManifest` already schedules the second
 * one 125 seconds later (`2 × cacheTtl + 5 s`); do not add a third, do not await
 * the delayed one, and do not reimplement the pointer → KV → purge ordering.
 *
 * A failed write is NOT SWALLOWED. Postgres has committed: the page is owned,
 * marked `live`, and either permanent or on a fresh clock, but the edge still
 * says gone. Answering "kept!" would be a lie the owner only discovers by
 * clicking their own link. The row is internally consistent and Postgres is the
 * authority, so the restore is replayable — by E07's divergence audit, or by any
 * later write on the page going through `writeManifest` again.
 *
 * `written.purge.ok === false` is NOT a failure (edge-purge contract §3): both
 * stores agree and `writeManifest` has already logged it.
 */
async function restoreManifest(restore: PendingRestore | null): Promise<void> {
  if (!restore) return;
  const written = await writeManifest(restore.slug, restore.manifest);
  if (written.ok) return;
  throw new StudioRefusal(
    "internal_error",
    RESTORE_INCOMPLETE_MESSAGE,
    `RESTORE INCOMPLETE — site ${restore.manifest.siteId} (slug "${restore.slug}") is kept and marked live in Postgres, but the manifest write failed at the "${written.step}" step: ${written.error}. The page is NOT serving; the row disagrees. E07 DIVERGENCE AUDIT: Postgres is the authority, never an R2 list (contract §7.5).`,
  );
}

/**
 * Keep a page: attach it to an account and, under the plan's cap, take the clock
 * off it. An `expired` page inside its grace window is the late keep — back to
 * `live`, and back on the internet once the transaction commits.
 *
 * Throws `SiteNotFoundError` (not yours / ended / past grace), a
 * `not_allowed_in_status` refusal (flagged), or — owner door only — an
 * `at_kept_limit` refusal. Every one of them is thrown before anything is written.
 */
export async function keepSite(
  siteId: string,
  profileId: string,
  options: KeepOptions = {},
): Promise<KeepSiteResult> {
  const door: KeepDoor = options.expectAnonymous ? "anonymous" : "owner";
  const { result, restore } = await db.transaction((tx) =>
    keepLocked(tx, siteId, profileId, door),
  );
  await restoreManifest(restore);
  return { ...result, restored: restore !== null };
}

export interface DemoteOptions {
  /** Compose inside an existing transaction (`swapKept`). Public callers pass none. */
  tx?: Tx;
}

/** Why a page that is not a kept `live` one cannot be demoted. */
function notDemotable(site: LockedSite): StudioRefusal {
  return new StudioRefusal(
    "not_allowed_in_status",
    site.expiresAt === null
      ? "This page is being reviewed, so it can't become a draft until the review finishes."
      : "This page is already a draft. Only a kept page can become one.",
  );
}

/**
 * Put a kept page back on a clock, freeing a slot.
 *
 * ONLY A KEPT `live` PAGE. A draft already has a clock — a second one would
 * silently move its deadline — and a flagged page is E07's to change. Ended,
 * foreign and past-grace rows are not found.
 *
 * ARCHIVE, DON'T DELETE: demote removes nothing. `status` stays `live`, the
 * slug stays, the manifest stays, R2 stays — the page keeps serving at the same
 * URL, it just has a deadline again. `owner_id`, `claimed_at`, `name_kind` and
 * `listed_public` are all untouched (AC14, D12): a demoted page is an *owned*
 * draft that keeps its name and its Explore choice for when it is kept again.
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
    const plan = await lockOwner(trx, profileId);
    const site = await lockSite(trx, siteId);
    const now = new Date();

    if (!site || site.ownerId !== profileId || isGone(site, now)) {
      throw new SiteNotFoundError(siteId);
    }
    if (site.expiresAt !== null || site.status !== "live") throw notDemotable(site);

    const { expiresAt, purgeAfter } = draftClocks(now);
    await trx.update(sites).set({ expiresAt, purgeAfter }).where(eq(sites.id, siteId));

    return {
      siteId: site.id,
      slug: site.slug,
      expiresAt: expiresAt.toISOString(),
      purgeAfter: purgeAfter.toISOString(),
      quota: quotaOf(await countKept(trx, profileId), plan),
    };
  });
}

/**
 * Demote one page and keep another in ONE transaction.
 *
 * The atomicity is the feature: a partial swap would leave the account either
 * a slot short or a page over the cap, and the second is the one that matters.
 * A must be a kept `live` page and B an owned draft — `live`, or `expired` in
 * its grace window, in which case B is restored exactly as a late keep is and
 * its manifest written once the swap has committed.
 *
 * Because the demote has written *within this transaction* by the time
 * `keepLocked` counts, the cap check sees the freed slot. An account already
 * over its limit (a plan change, edge case 8) is still over it after one demote,
 * and B is refused `at_kept_limit` with A rolled back.
 */
export async function swapKept(
  demoteSiteId: string,
  keepSiteId: string,
  profileId: string,
): Promise<SwapResult> {
  const { demoted, kept, restore } = await db.transaction(async (tx) => {
    const demoted = await demoteSite(demoteSiteId, profileId, { tx });
    const { result, restore } = await keepLocked(tx, keepSiteId, profileId, "swap");
    // The swap door throws at the cap rather than landing `owned_draft`, so this
    // only narrows the type; reaching it would mean that rule was removed.
    if (result.outcome !== "kept") {
      throw new Error(
        `swapKept: keeping ${keepSiteId} landed "${result.outcome}" — the swap door must refuse at the cap. Rolling back.`,
      );
    }
    return { demoted, kept: result, restore };
  });

  await restoreManifest(restore);

  // Both halves report the SAME post-swap quota. `demoted.quota` was measured
  // between the two writes, when the account was one page short.
  return { demoted: { ...demoted, quota: kept.quota }, kept };
}
