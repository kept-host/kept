/**
 * The studio's visits reads — E06 task 011 (PRD §5.1, D8).
 *
 * `page_views_daily` is written once a day by the visits sync (`lib/visits/`),
 * never per view; this module only reads it. Task 012 adds the page-detail
 * daily series here, so every visits read the studio makes lives in one file.
 *
 * ⚠️ NO ROWS IS NOT ZERO. A page the sync has never seen has no rows, and the
 * studio says "no data yet" rather than a confident `0` (PRD §9.2: "never a
 * bare 0 as the headline"). So a page with no rows is simply absent from
 * `recentVisitsByOwner`'s map, and the caller turns absence into `null`.
 */
import { VISITS_RECENT_DAYS, VISITS_SYNC_JOB } from "@kept/shared";
import { and, eq, gte, sql } from "drizzle-orm";

import { db } from "../index";
import { jobRuns, pageViewsDaily, sites } from "../schema";

/**
 * Each of the owner's pages → its visits over the last `VISITS_RECENT_DAYS`
 * complete UTC days. One grouped query for the whole account.
 *
 * The window starts `VISITS_RECENT_DAYS` days before today (UTC). Today itself
 * never has a row — the sync only writes complete days — so "the last N days"
 * is exactly the N rows before today.
 */
export async function recentVisitsByOwner(ownerId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({
      siteId: pageViewsDaily.siteId,
      visits: sql<number>`sum(${pageViewsDaily.views})::int`,
    })
    .from(pageViewsDaily)
    .innerJoin(sites, eq(sites.id, pageViewsDaily.siteId))
    .where(
      and(
        eq(sites.ownerId, ownerId),
        gte(
          pageViewsDaily.day,
          sql`(now() at time zone 'utc')::date - ${VISITS_RECENT_DAYS}::int`,
        ),
      ),
    )
    .groupBy(pageViewsDaily.siteId);

  return new Map(rows.map((row) => [row.siteId, row.visits]));
}

/**
 * When the visits sync last succeeded — the studio's "as of". `null` when it
 * has never run. `job` exists for the drills, which run under their own job
 * name rather than touching the real one.
 */
export async function lastVisitsSync(job: string = VISITS_SYNC_JOB): Promise<Date | null> {
  const [row] = await db
    .select({ lastSuccessAt: jobRuns.lastSuccessAt })
    .from(jobRuns)
    .where(eq(jobRuns.job, job));
  return row?.lastSuccessAt ?? null;
}
