/**
 * Every SQL statement the signed-in owner's screens read — E06 tasks 002, 011.
 *
 * Same split as `./publish.ts` and `./reminders.ts`: route handlers and server
 * components hold HTTP and JSX, this module holds the queries. `/dashboard`,
 * the page-detail screen and `/settings` are RSC **reads** and go straight to Postgres
 * from the server component (the locked rule); every mutation goes through the
 * owner routes and never through here.
 *
 * ── WHAT THE HOME SHOWS (PRD §5.1) ───────────────────────────────────────────
 *
 * - **Kept** is `isKeptCondition` from `lib/sites/keep.ts` — the one definition
 *   the cap counts with — so the wall and the `KEPT k / limit` counter can never
 *   disagree. `archived` and `removed` are not kept (latent bug 5: archived kept
 *   rows used to leak onto the wall).
 * - **Drafts** are the owner's clocked pages that are still `live`,
 *   `under_review` or `quarantined`, plus `expired` ones still inside their grace
 *   window (`purge_after > now()`) — those can still be kept late (§5.3).
 *   Flagged pages are shown, labelled, never hidden: a page that vanishes when it
 *   is flagged is indistinguishable from data loss.
 *
 * `isDraft = expires_at != null` is the split and nothing more. Whether a draft
 * has already run out is the clock's business, resolved at render time — never
 * by `status`, because an expired-but-unswept row still says `live` until E07's
 * sweep runs.
 */
import { type KeptQuota, type SiteStatus } from "@kept/shared";
import { and, desc, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";

import { chosenNameCount } from "../../names/check";
import { isKeptCondition, keptQuotaFor } from "../../sites/keep";
import { db } from "../index";
import { siteVersions, sites } from "../schema";
import { lastVisitsSync, recentVisitsByOwner } from "./visits";

/**
 * One of the owner's pages, with everything a card or the detail screen needs.
 *
 * EXPORTED SO NO CONSUMER RE-DECLARES IT. `Date` rather than ISO strings: a
 * server component reads it and hands it on; React serialises a `Date` across
 * the client boundary intact.
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

/** A page on the home: the row plus its recent visits. */
export interface DashboardSite extends OwnedSite {
  /** The `VISITS_RECENT_DAYS` sum; `null` when the sync has no rows for it. */
  visits: number | null;
}

/** Everything `/dashboard` renders, from one read of the owner's rows. */
export interface DashboardSites {
  /** `isKeptCondition` — the wall, most recently updated first. */
  kept: DashboardSite[];
  /** The drafts strip, soonest `expires_at` first. */
  drafts: DashboardSite[];
  /** The kept allowance, from `keptQuotaFor` — the cap's own count and plan limit. */
  quota: KeptQuota;
  /** Chosen names counted against the name quota (`chosenNameCount`, D3). */
  names: number;
  /** When the visits sync last succeeded; `null` when it never has. */
  visitsAsOf: Date | null;
  /**
   * The visits read failed. The pages are complete — only their visits are
   * missing — so the home renders and says so (PRD §9.1 partial load error).
   */
  visitsFailed: boolean;
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

/** A draft still serving, or under review: on the home whatever its clock says. */
const ACTIVE_DRAFT_STATUSES = [
  "live",
  "under_review",
  "quarantined",
] as const satisfies readonly SiteStatus[];

/** The owner's drafts the home shows — see the header. */
function homeDraftCondition(profileId: string) {
  return and(
    eq(sites.ownerId, profileId),
    isNotNull(sites.expiresAt),
    or(
      inArray(sites.status, [...ACTIVE_DRAFT_STATUSES]),
      and(eq(sites.status, "expired"), gt(sites.purgeAfter, sql`now()`)),
    ),
  );
}

/**
 * Everything the home needs for one owner.
 *
 * ONE ROW QUERY FOR THE WHOLE SCREEN. The join to `site_versions` is a LEFT join
 * so a row whose version is missing still appears; an INNER join would silently
 * drop a page from its owner's own home. The quota and the names count run
 * concurrently with it, so the screen costs one round trip of latency.
 *
 * Visits are secondary: if their read fails the pages still render, with
 * `visitsFailed` set, rather than the whole home failing over a number that is
 * approximate by design (D8).
 *
 * An account with no pages returns two empty arrays and a `0 of {its plan's
 * limit}` quota. Empty is a state, not an error.
 */
export async function getDashboardSites(profileId: string): Promise<DashboardSites> {
  const [rows, quota, names, visitsRead] = await Promise.all([
    db
      .select(OWNED_SITE_COLUMNS)
      .from(sites)
      .leftJoin(siteVersions, eq(siteVersions.id, sites.currentVersionId))
      .where(or(isKeptCondition(profileId), homeDraftCondition(profileId)))
      .orderBy(desc(sites.updatedAt)),
    keptQuotaFor(profileId),
    chosenNameCount(profileId),
    Promise.all([recentVisitsByOwner(profileId), lastVisitsSync()]).then(
      ([visits, asOf]) => ({ ok: true as const, visits, asOf }),
      (error: unknown) => {
        console.error("[dashboard] visits read failed; rendering without visits", error);
        return { ok: false as const };
      },
    ),
  ]);

  const kept: DashboardSite[] = [];
  const drafts: DashboardSite[] = [];
  for (const row of rows) {
    const site = { ...row, visits: visitsRead.ok ? (visitsRead.visits.get(row.id) ?? null) : null };
    (row.expiresAt === null ? kept : drafts).push(site);
  }
  // Soonest deadline first: the draft that needs a decision soonest leads.
  // Every row here has a clock — that is what put it in `drafts`.
  drafts.sort((a, b) => (a.expiresAt?.getTime() ?? 0) - (b.expiresAt?.getTime() ?? 0));

  return {
    kept,
    drafts,
    quota,
    names,
    visitsAsOf: visitsRead.ok ? visitsRead.asOf : null,
    visitsFailed: !visitsRead.ok,
  };
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
