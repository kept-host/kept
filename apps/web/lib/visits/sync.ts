/**
 * The visits sync — E06 task 009 (D8, PRD §5.6).
 *
 *   for each requested UTC day, oldest first:
 *     Cloudflare aggregates (graphql.ts) ─▶ host → site (map.ts) ─▶ upsert page_views_daily
 *   wrapped in job_runs('visits-sync'): attempt stamped first, success or error last
 *
 * THE ONLY TWO TABLES THIS WRITES are `page_views_daily` and `job_runs` (AC35).
 * Nothing here — and nothing anywhere — writes per page view: the counts are
 * Cloudflare's own, read once a day, so the serve path stays exactly as it was.
 *
 * IDEMPOTENT BY CONSTRUCTION. A day's row is an upsert keyed on
 * `(site_id, day)` that REPLACES `views`, so re-running a day — a retried
 * workflow, a manual `?days=30` over days already synced — overwrites and can
 * never double-count.
 *
 * FAILURE IS LOUD. Any error is recorded in `job_runs.last_error` and re-thrown,
 * so the route answers non-2xx and the scheduled run goes red; the studio keeps
 * the previous rows and the previous "as of". Days written before the failing
 * one stay written — they are correct, and the next run overwrites them anyway.
 */
import { VISITS_HISTORY_DAYS, VISITS_SYNC_JOB } from "@kept/shared";
import { and, eq, gte, lt, notInArray, sql } from "drizzle-orm";

import { db } from "../db";
import { jobRuns, nameEvents, pageViewsDaily, sites } from "../db/schema";
import { servingBaseDomain } from "../storage/env";
import { fetchVisitGroups } from "./graphql";
import { mapVisits, type NameEvent, type VisitRow } from "./map";

/** `YYYY-MM-DD` of a UTC instant. */
function utcDay(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** `[00:00Z, next day 00:00Z)` of a `YYYY-MM-DD` UTC day. */
export function dayBounds(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

/**
 * The `count` most recent COMPLETE UTC days before `now`, oldest first. Today
 * is never included: its counts are still arriving, and a partial day written
 * now would be a smaller number the studio shows until tomorrow's run.
 */
export function completeUtcDays(count: number, now: Date = new Date()): string[] {
  const days: string[] = [];
  for (let back = count; back >= 1; back--) {
    const day = new Date(now);
    day.setUTCDate(day.getUTCDate() - back);
    days.push(utcDay(day));
  }
  return days;
}

/**
 * `?days=` → how many days to sync: absent means 1, otherwise a whole number
 * from 1 to `VISITS_HISTORY_DAYS` — the retention Cloudflare's adaptive
 * datasets allow. Anything else is `null`, which the route answers with 400.
 */
export function parseSyncDays(raw: string | null): number | null {
  if (raw === null) return 1;
  if (!/^\d+$/.test(raw)) return null;
  const days = Number(raw);
  return days >= 1 && days <= VISITS_HISTORY_DAYS ? days : null;
}

/**
 * Run `work` as scheduled job `job`, recording it in `job_runs`:
 * `last_attempt_at` before the work starts; on success `last_success_at` and a
 * cleared `last_error`; on failure `last_error` and the error re-thrown.
 */
export async function withJobRun<T>(job: string, work: () => Promise<T>): Promise<T> {
  await db
    .insert(jobRuns)
    .values({ job, lastAttemptAt: sql`now()` })
    .onConflictDoUpdate({ target: jobRuns.job, set: { lastAttemptAt: sql`now()` } });

  try {
    const result = await work();
    await db
      .update(jobRuns)
      .set({ lastSuccessAt: sql`now()`, lastError: null })
      .where(eq(jobRuns.job, job));
    return result;
  } catch (error) {
    await db
      .update(jobRuns)
      .set({ lastError: error instanceof Error ? error.message : String(error) })
      .where(eq(jobRuns.job, job));
    throw error;
  }
}

/**
 * Upsert mapped rows: a `(site_id, day)` already present has its `views`
 * REPLACED, never added to. Returns how many rows were written.
 */
export async function writeVisitRows(rows: readonly VisitRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  await db
    .insert(pageViewsDaily)
    .values([...rows])
    .onConflictDoUpdate({
      target: [pageViewsDaily.siteId, pageViewsDaily.day],
      set: { views: sql`excluded.views` },
    });
  return rows.length;
}

/**
 * Every name a page answers to today → its site. The predicate is
 * `sites_slug_key`'s own: an archived or removed row has released its name.
 */
async function loadCurrentNames(): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: sites.id, slug: sites.slug })
    .from(sites)
    .where(notInArray(sites.status, ["archived", "removed"]));
  return new Map(rows.map((row) => [row.slug, row.id]));
}

/**
 * The renames made during each of `days`, keyed by UTC day — one query.
 *
 * Only renames whose page still exists. `name_events.site_id` has no FK (the
 * history outlives the page), but `page_views_daily.site_id` does: one event
 * for a purged page would map its host to a missing site and fail the whole
 * run's upsert. Its visits have nowhere to go, so the event is left out here.
 */
export async function loadNameEventsByDay(
  days: readonly string[],
): Promise<Map<string, NameEvent[]>> {
  const byDay = new Map<string, NameEvent[]>();
  const first = days[0];
  const last = days.at(-1);
  if (first === undefined || last === undefined) return byDay;

  const rows = await db
    .select({
      siteId: nameEvents.siteId,
      oldName: nameEvents.oldName,
      newName: nameEvents.newName,
      createdAt: nameEvents.createdAt,
    })
    .from(nameEvents)
    .innerJoin(sites, eq(sites.id, nameEvents.siteId))
    .where(
      and(
        gte(nameEvents.createdAt, dayBounds(first).start),
        lt(nameEvents.createdAt, dayBounds(last).end),
      ),
    );

  for (const { createdAt, ...event } of rows) {
    const day = utcDay(createdAt);
    byDay.set(day, [...(byDay.get(day) ?? []), event]);
  }
  return byDay;
}

/** What one run reports — counts only, safe in a public build log. */
export interface VisitsSyncResult {
  /** UTC days synced. */
  days: number;
  /** `page_views_daily` rows written across them. */
  rows: number;
}

/** Sync `days` (`YYYY-MM-DD`, oldest first) from Cloudflare into `page_views_daily`. */
export function syncVisits(days: readonly string[]): Promise<VisitsSyncResult> {
  return withJobRun(VISITS_SYNC_JOB, async () => {
    const baseDomain = servingBaseDomain();
    const currentNames = await loadCurrentNames();
    const eventsByDay = await loadNameEventsByDay(days);

    let rows = 0;
    for (const day of days) {
      const { start, end } = dayBounds(day);
      const groups = await fetchVisitGroups(start, end);
      rows += await writeVisitRows(
        mapVisits(groups, {
          day,
          baseDomain,
          currentNames,
          nameEventsForDay: eventsByDay.get(day) ?? [],
        }),
      );
    }
    return { days: days.length, rows };
  });
}
