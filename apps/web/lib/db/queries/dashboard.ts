/**
 * Every SQL statement the signed-in owner's screens read — E06 task 002.
 *
 * Same split as `./publish.ts` and `./reminders.ts`: route handlers and server
 * components hold HTTP and JSX, this module holds the queries. `/dashboard`,
 * `/site/[slug]` and `/settings` are RSC **reads** and go straight to Postgres
 * from the server component (the locked rule); every mutation goes through the
 * owner routes and never through here.
 *
 * ── THREE THINGS THIS MODULE DELIBERATELY DOES NOT DO ─────────────────────────
 *
 * 1. **It does not define kept-ness.** `owner_id = ? AND expires_at IS NULL AND
 *    status = 'live'` lives once, in `lib/sites/keep.ts`'s `isKeptCondition`,
 *    and the number the dashboard prints comes from `keptQuotaFor` — the same
 *    function the cap branch counts with. A dashboard that computes its own
 *    quota is a dashboard that will eventually disagree with the endpoint that
 *    enforces it.
 *
 * 2. **It does not hide rows.** `archived`, `quarantined`, `under_review` and
 *    `expired` all come back. The dashboard *renders* those states; a page that
 *    vanishes when it is flagged is indistinguishable from data loss. `archived`
 *    is excluded from the **quota** — by `isKeptCondition`'s status clause, one
 *    layer down — and that is a different question from what a screen may read.
 *
 * 3. **It does not derive a phase.** `isDraft = expires_at != null` is the split
 *    below and nothing more. Whether a draft has already run out is the clock's
 *    business, resolved at render time by `components/kept/draft-chip.tsx` —
 *    never by `status`, because an expired-but-unswept row still says `live`
 *    until E07's sweep runs.
 */
import type { SiteStatus } from "@kept/shared";
import type { KeptQuota } from "@kept/shared";
import { and, desc, eq } from "drizzle-orm";

import { keptQuotaFor } from "../../sites/keep";
import { db } from "../index";
import { siteVersions, sites } from "../schema";

/**
 * One of the owner's pages, with everything a card or the detail screen needs.
 *
 * EXPORTED SO NO CONSUMER RE-DECLARES IT (E06 tasks 003 / 008 / 009 / 010).
 * `Date` rather than ISO strings: this never crosses the wire — a server
 * component reads it and hands the `Date` to `draftCountdown`, which takes one.
 */
export interface OwnedSite {
  id: string;
  slug: string;
  /**
   * The page's own `<title>` (E06 task 001), or `null` when it had none, had an
   * empty one, or predates migration `0004`. Render `title ?? slug` — that
   * fallback is the whole reason `0004` backfills nothing.
   */
  title: string | null;
  status: SiteStatus;
  /** Null while the row has no current version (never, after a successful publish). */
  currentVersionId: string | null;
  /** The draft clock. Set → draft; null → kept. The ONLY split there is. */
  expiresAt: Date | null;
  /** End of the post-expiry grace window; null on a kept page. */
  purgeAfter: Date | null;
  /** Denormalised on `sites`, so a card renders a size with no join needed. */
  sizeBytes: number | null;
  updatedAt: Date;
  /** When the current version's bytes were written — "updated 3 days ago". */
  versionCreatedAt: Date | null;
}

/** Everything `/dashboard` renders, from one read of the owner's rows. */
export interface DashboardSites {
  /** `expires_at IS NULL`. Permanent pages — the wall. */
  kept: OwnedSite[];
  /** `expires_at != null`. Owned drafts, on a clock — the drafts section. */
  drafts: OwnedSite[];
  /**
   * The kept allowance, from `keptQuotaFor` — NOT counted from `kept.length`.
   *
   * They can legitimately differ: `kept` above holds every clockless row the
   * account owns, including an `archived` one, while the quota counts only what
   * the cap counts. Deriving the number from the array would quietly reinstate
   * the second definition this whole task exists to delete.
   */
  quota: KeptQuota;
}

/**
 * The columns both reads project. One object so the two queries cannot drift in
 * shape, which is what would make `OwnedSite` a lie on one of the two paths.
 */
const OWNED_SITE_COLUMNS = {
  id: sites.id,
  slug: sites.slug,
  title: sites.title,
  status: sites.status,
  currentVersionId: sites.currentVersionId,
  expiresAt: sites.expiresAt,
  purgeAfter: sites.purgeAfter,
  sizeBytes: sites.sizeBytes,
  updatedAt: sites.updatedAt,
  versionCreatedAt: siteVersions.createdAt,
} as const;

/**
 * Everything the dashboard needs for one owner.
 *
 * ONE ROW QUERY FOR THE WHOLE SCREEN — not five, and emphatically not one per
 * card. The join to `site_versions` is a LEFT join on `sites.current_version_id`
 * so a row whose version is missing still appears (with `versionCreatedAt`
 * null); an INNER join would silently drop a page from its owner's own
 * dashboard, which is the worst failure this screen has.
 *
 * The quota is the *second* statement and it runs CONCURRENTLY with the rows, so
 * the screen still costs one round trip of latency. It is a separate statement
 * on purpose: it must be `keptQuotaFor`'s count and no other, for the reason in
 * `DashboardSites.quota`.
 *
 * An account with no pages returns two empty arrays and a `0 of {its plan's
 * limit}` quota. Empty is a state, not an error — nothing here throws for it.
 */
export async function getDashboardSites(profileId: string): Promise<DashboardSites> {
  const [rows, quota] = await Promise.all([
    db
      .select(OWNED_SITE_COLUMNS)
      .from(sites)
      .leftJoin(siteVersions, eq(siteVersions.id, sites.currentVersionId))
      .where(eq(sites.ownerId, profileId))
      // Most recently touched first — the page you just published or replaced is
      // the one you came back to look at.
      .orderBy(desc(sites.updatedAt)),
    keptQuotaFor(profileId),
  ]);

  const kept: OwnedSite[] = [];
  const drafts: OwnedSite[] = [];
  for (const row of rows) {
    // `isDraft = expires_at != null`. There is no draft status, no `is_draft`
    // column and no second predicate — see `../schema.ts` on `sites.expiresAt`.
    (row.expiresAt === null ? kept : drafts).push(row);
  }

  return { kept, drafts, quota };
}

/**
 * One of the owner's pages by slug, for `/site/[slug]`.
 *
 * ⚠️ THE OWNER SCOPE IS IN THE SQL, NOT APPLIED AFTERWARDS IN JS. This read
 * feeds a screen that renders a *preview* of the page's bytes, so fetching by
 * slug and then checking `row.ownerId === profileId` in the caller is a
 * cross-account read that happens to be discarded — one forgotten early return
 * away from being served. `owner_id` is in the WHERE clause.
 *
 * A slug that exists but belongs to someone else returns `null`, byte-identical
 * to a slug that never existed. That is the same rule `ownerNotFound()` encodes
 * for the routes: "you don't own this" is an existence oracle, and the caller
 * has no way to tell the two apart because there is nothing here to tell it
 * with.
 */
export async function getOwnedSiteBySlug(
  profileId: string,
  slug: string,
): Promise<OwnedSite | null> {
  const [row] = await db
    .select(OWNED_SITE_COLUMNS)
    .from(sites)
    .leftJoin(siteVersions, eq(siteVersions.id, sites.currentVersionId))
    .where(and(eq(sites.ownerId, profileId), eq(sites.slug, slug)))
    .limit(1);

  return row ?? null;
}
