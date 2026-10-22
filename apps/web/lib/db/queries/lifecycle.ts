/**
 * Every SQL statement the end-of-life jobs run (E07 §6.13, D14): `expire`
 * (`lib/lifecycle/expire.ts`) and `purge` (`lib/lifecycle/purge.ts`).
 *
 * The candidate reads are UNLOCKED and only nominate: each job re-reads its
 * site under `lockOwner` (owned pages) → the site row (`lockSiteForModeration`)
 * and decides there, because a late keep, a flag or an appeal can land between
 * the read and the lock (edge case 13).
 *
 * `scope` limits a sweep to the given site ids. Only the drills pass it: a test
 * run against the shared dev database must never expire or purge a page it did
 * not create. The cron routes never do.
 */
import { REPORTER_CONTACT_RETENTION_DAYS, type SiteStatus } from "@kept/shared";
import { and, asc, eq, inArray, isNotNull, lt, notExists, or, sql, type SQL } from "drizzle-orm";

import { db, type Tx } from "../index";
import { abuseReports, appeals, sites } from "../schema";

/**
 * The statuses `purge` collects once `purge_after` has passed (§6.13). `live`
 * is absent on purpose: a live page past its clock is `expire`'s first, so the
 * edge says 410 for the grace window before anything is deleted.
 */
export const PURGEABLE_STATUSES = [
  "expired",
  "archived",
  "removed",
  "under_review",
  "quarantined",
] as const satisfies readonly SiteStatus[];

function inScope(scope: readonly string[] | undefined): SQL | undefined {
  return scope ? inArray(sites.id, [...scope]) : undefined;
}

/**
 * Live drafts past their clock, nearest first — the predicate of
 * `sites_live_expires_idx` (`status = 'live' AND expires_at IS NOT NULL`) plus
 * the bound, so the partial index serves it and the `LIMIT` ends the scan
 * (AC40 asserts the plan). Exported as a query, not a promise, for that EXPLAIN.
 */
export function dueExpiriesQuery(limit: number, scope?: readonly string[]) {
  return db
    .select({ id: sites.id })
    .from(sites)
    .where(
      and(
        eq(sites.status, "live"),
        isNotNull(sites.expiresAt),
        lt(sites.expiresAt, sql`now()`),
        inScope(scope),
      ),
    )
    .orderBy(asc(sites.expiresAt))
    .limit(limit);
}

export async function dueExpiries(limit: number, scope?: readonly string[]): Promise<string[]> {
  const rows = await dueExpiriesQuery(limit, scope);
  return rows.map((row) => row.id);
}

/** The expiry itself, inside the caller's locked transaction. */
export async function markExpired(tx: Tx, siteId: string): Promise<void> {
  await tx.update(sites).set({ status: "expired", updatedAt: new Date() }).where(eq(sites.id, siteId));
}

/** An open appeal on this site — purge waits for the decision (edge case 24). */
function isOpenAppealOn(siteId: typeof sites.id | string): SQL | undefined {
  return and(eq(appeals.siteId, siteId), eq(appeals.status, "open"));
}

/**
 * Pages past `purge_after` in a purgeable status with no open appeal, oldest
 * first (`sites_status_purge_after_idx`).
 */
export async function duePurges(limit: number, scope?: readonly string[]): Promise<string[]> {
  const rows = await db
    .select({ id: sites.id })
    .from(sites)
    .where(
      and(
        inArray(sites.status, [...PURGEABLE_STATUSES]),
        lt(sites.purgeAfter, sql`now()`),
        notExists(db.select({ id: appeals.id }).from(appeals).where(isOpenAppealOn(sites.id))),
        inScope(scope),
      ),
    )
    .orderBy(asc(sites.purgeAfter))
    .limit(limit);
  return rows.map((row) => row.id);
}

/** The under-the-lock re-check of the appeal half of `duePurges`. */
export async function hasOpenAppeal(tx: Tx, siteId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: appeals.id })
    .from(appeals)
    .where(isOpenAppealOn(siteId))
    .limit(1);
  return row !== undefined;
}

/**
 * The row itself. `site_versions`, `scans` and `appeals` cascade with it;
 * `moderation_actions` and `abuse_reports` keep their rows (`SET NULL` + their
 * own `slug`); `name_holds` and `pending_purges` carry no FK and stay.
 */
export async function deleteSiteRow(tx: Tx, siteId: string): Promise<void> {
  await tx.delete(sites).where(eq(sites.id, siteId));
}

/**
 * Forget a reporter's name and email `REPORTER_CONTACT_RETENTION_DAYS` after
 * their report was resolved (§6.13). The report itself stays. Returns how many
 * reports were cleared; a second run clears none.
 */
export async function clearResolvedReporterContacts(): Promise<number> {
  const cleared = await db
    .update(abuseReports)
    .set({ reporterName: null, reporterEmail: null })
    .where(
      and(
        lt(
          abuseReports.resolvedAt,
          sql`now() - make_interval(days => ${REPORTER_CONTACT_RETENTION_DAYS})`,
        ),
        or(isNotNull(abuseReports.reporterName), isNotNull(abuseReports.reporterEmail)),
      ),
    )
    .returning({ id: abuseReports.id });
  return cleared.length;
}
