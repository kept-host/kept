/**
 * Every SQL statement the scan runtime runs (E07 §6.1, §6.5, §6.12) — the
 * `scans` rows, what a scan reads to judge a version, what `scan-retry` picks
 * up, and the spike check's day bookkeeping in `job_runs`. Kept here so no SQL
 * lives in `lib/scan/run.ts` or the cron route.
 */
import {
  SCAN_POLICY_VERSION,
  SPIKE_BASELINE_DAYS,
  SPIKE_DAILY_CAP,
  SPIKE_MIN_VISITS,
  SPIKE_MULTIPLIER,
  UNSCANNED_GRACE_MINUTES,
  type ModerationReason,
  type ScanStatus,
  type ScanTrigger,
  type ScanVerdict,
} from "@kept/shared";
import { and, count, desc, eq, gt, lt, lte, notExists, or, sql } from "drizzle-orm";

import { db } from "../index";
import { jobRuns, scans, sites, siteVersions } from "../schema";

/** A version as a scan needs it: what to read, how to address it, what it hashes to. */
export interface ScanTarget {
  siteId: string;
  versionId: string;
  slug: string;
  contentHash: string;
  r2Key: string;
}

const targetColumns = {
  siteId: siteVersions.siteId,
  versionId: siteVersions.id,
  slug: sites.slug,
  contentHash: siteVersions.contentHash,
  r2Key: siteVersions.r2Key,
};

/** `versionId` of `siteId`, or `null` when there is no such version of that page. */
export async function scanTarget(siteId: string, versionId: string): Promise<ScanTarget | null> {
  const [row] = await db
    .select(targetColumns)
    .from(siteVersions)
    .innerJoin(sites, eq(sites.id, siteVersions.siteId))
    .where(and(eq(siteVersions.id, versionId), eq(siteVersions.siteId, siteId)));
  return row ?? null;
}

/** Step 1: the `pending` row, written before anything can fail. Returns its id. */
export async function insertScan(target: ScanTarget, trigger: ScanTrigger): Promise<string> {
  const [row] = await db
    .insert(scans)
    .values({
      siteId: target.siteId,
      versionId: target.versionId,
      contentHash: target.contentHash,
      trigger,
      policyVersion: SCAN_POLICY_VERSION,
    })
    .returning({ id: scans.id });
  if (!row) throw new Error("scans insert returned no row");
  return row.id;
}

/**
 * Step 2 (D7): the latest `done` scan of the same bytes under the same policy,
 * from any page — served by `scans_content_hash_policy_idx`.
 */
export async function reusableScan(contentHash: string) {
  const [row] = await db
    .select({
      id: scans.id,
      verdict: scans.verdict,
      rule: scans.rule,
      reason: scans.reason,
      model: scans.model,
      facts: scans.facts,
      answers: scans.answers,
    })
    .from(scans)
    .where(
      and(
        eq(scans.contentHash, contentHash),
        eq(scans.policyVersion, SCAN_POLICY_VERSION),
        eq(scans.status, "done"),
      ),
    )
    .orderBy(desc(scans.completedAt))
    .limit(1);
  return row ?? null;
}

/** What one attempt wrote to its row. `attempts` and `completed_at` are set here. */
export interface ScanFinish {
  status: Exclude<ScanStatus, "pending">;
  attempts: number;
  nextAttemptAt: Date | null;
  verdict: ScanVerdict | null;
  rule: string | null;
  reason: ModerationReason | null;
  model: string | null;
  facts: unknown;
  answers: unknown;
  costUsd: string | null;
  error: string | null;
}

export async function finishScan(scanId: string, finish: ScanFinish): Promise<void> {
  await db
    .update(scans)
    .set({ ...finish, completedAt: sql`now()` })
    .where(eq(scans.id, scanId));
}

/** A row to run again, with the version it judges. */
export type DueScan = ScanTarget & { id: string; attempts: number };

/**
 * `scan-retry`'s due rows: `failed` with `next_attempt_at` reached (a final
 * failure has none and is never selected), and `pending` rows older than the
 * grace — a process that died mid-scan. Oldest first.
 */
export async function dueScans(limit: number): Promise<DueScan[]> {
  return db
    .select({ id: scans.id, attempts: scans.attempts, ...targetColumns })
    .from(scans)
    .innerJoin(siteVersions, eq(siteVersions.id, scans.versionId))
    .innerJoin(sites, eq(sites.id, scans.siteId))
    .where(
      or(
        and(eq(scans.status, "failed"), lte(scans.nextAttemptAt, sql`now()`)),
        and(
          eq(scans.status, "pending"),
          lt(scans.createdAt, sql`now() - make_interval(mins => ${UNSCANNED_GRACE_MINUTES})`),
        ),
      ),
    )
    .orderBy(scans.createdAt)
    .limit(limit);
}

/**
 * Live pages whose current version has no `scans` row at all and became current
 * before `activatedBefore`, newest first (a crash before step 1 is recent; the
 * pre-E07 backlog is old). `limit` absent: every one.
 */
export async function unscannedLiveVersions(activatedBefore: Date, limit?: number): Promise<ScanTarget[]> {
  const query = db
    .select(targetColumns)
    .from(sites)
    .innerJoin(siteVersions, eq(siteVersions.id, sites.currentVersionId))
    .where(
      and(
        eq(sites.status, "live"),
        lt(siteVersions.activatedAt, activatedBefore),
        notExists(db.select({ one: sql`1` }).from(scans).where(eq(scans.versionId, siteVersions.id))),
      ),
    )
    .orderBy(desc(siteVersions.activatedAt));
  return limit === undefined ? query : query.limit(limit);
}

/** Every live page's current version, newest first. `limit` absent: every one. */
export async function liveVersions(limit?: number): Promise<ScanTarget[]> {
  const query = db
    .select(targetColumns)
    .from(sites)
    .innerJoin(siteVersions, eq(siteVersions.id, sites.currentVersionId))
    .where(eq(sites.status, "live"))
    .orderBy(desc(siteVersions.activatedAt));
  return limit === undefined ? query : query.limit(limit);
}

/** Failed attempts finished in the last 24 h, and the most recent one's error. */
export async function recentScanFailures(): Promise<{ failures: number; lastError: string | null }> {
  const recent = and(eq(scans.status, "failed"), gt(scans.completedAt, sql`now() - interval '24 hours'`));
  const [total] = await db.select({ failures: count() }).from(scans).where(recent);
  const [last] = await db
    .select({ error: scans.error })
    .from(scans)
    .where(recent)
    .orderBy(desc(scans.completedAt))
    .limit(1);
  return { failures: total?.failures ?? 0, lastError: last?.error ?? null };
}

// ── the spike check (§6.12) ──────────────────────────────────────────────────

/** A scheduled job's last success and checked day; `null` when it never ran. */
export async function jobRun(job: string) {
  const [row] = await db
    .select({ lastSuccessAt: jobRuns.lastSuccessAt, lastDay: jobRuns.lastDay })
    .from(jobRuns)
    .where(eq(jobRuns.job, job));
  return row ?? null;
}

/** Record the UTC day `job` finished checking (`withJobRun` has written its row). */
export async function setJobLastDay(job: string, day: string): Promise<void> {
  await db.update(jobRuns).set({ lastDay: day }).where(eq(jobRuns.job, job));
}

/**
 * Live pages whose visits on `day` are ≥ `SPIKE_MIN_VISITS` and ≥
 * `SPIKE_MULTIPLIER` × their average over the `SPIKE_BASELINE_DAYS` before it
 * (a missing day is 0; the average is at least 1). Reads only those days of
 * `page_views_daily`; at most `SPIKE_DAILY_CAP`, busiest first.
 */
export async function spikingPages(day: string): Promise<{ siteId: string; versionId: string }[]> {
  const rows = await db.execute<{ site_id: string; version_id: string }>(sql`
    with days as (
      select
        site_id,
        coalesce(sum(views) filter (where day = ${day}::date), 0) as day_views,
        coalesce(sum(views) filter (where day < ${day}::date), 0) as baseline_views
      from page_views_daily
      where day between ${day}::date - ${SPIKE_BASELINE_DAYS}::int and ${day}::date
      group by site_id
    )
    select s.id as site_id, s.current_version_id as version_id
    from days d
    join sites s on s.id = d.site_id
    where s.status = 'live'
      and s.current_version_id is not null
      and d.day_views >= ${SPIKE_MIN_VISITS}
      and d.day_views >= ${SPIKE_MULTIPLIER} * greatest(1, d.baseline_views::numeric / ${SPIKE_BASELINE_DAYS})
    order by d.day_views desc
    limit ${SPIKE_DAILY_CAP}
  `);
  return rows.map((row) => ({ siteId: row.site_id, versionId: row.version_id }));
}
