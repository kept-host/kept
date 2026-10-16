/**
 * The scan runtime (E07 §6.1, §6.5, §6.12): one version → a `scans` row → a
 * verdict, and the `scan-retry` job that finishes what the first attempt could
 * not.
 *
 *   1. insert the scans row (pending, trigger)   ← before anything can fail
 *   2. reuse a `done` scan of the same (content_hash, SCAN_POLICY_VERSION)
 *   3. read the version's HTML from R2
 *   4. extract → facts + text
 *   5. classify → typed answers + cost          — `skipped` when the scanner is off (D17)
 *   6. decide (pure)
 *   7. flag → setStatus(under_review, scanner, automated)
 *   8. the row → done / skipped
 *
 *   classifier error → decide(facts, null): only P4 can fire, and is acted on
 *                      as in 7; then the row is `failed` with its retry time
 *   any other error  → `failed` likewise
 *
 * NEVER THROWS TO THE CALLER. The publish paths reach this through
 * `enqueueScan` (fire and forget, `lib/publish/hooks.ts`); the cron job and the
 * admin CLI await `runScan` directly. A page stays live whatever happens here —
 * only a flag moves it, and only through `setStatus`, which holds D4.
 *
 * Nothing here reads `OPENROUTER_API_KEY` at import time: the classifier is
 * resolved per call (`defaultClassifier()`), so a deploy without the key
 * scans with P4 alone and records `skipped`.
 */
import {
  JOB_DEADLINE_SECONDS,
  SCAN_FAILURE_ALERT_DAY,
  SCAN_FAILURE_ALERT_THRESHOLD,
  SCAN_RETRY_BATCH_SIZE,
  SCAN_RETRY_DELAYS,
  UNSCANNED_GRACE_MINUTES,
  type ModerationReason,
  type ScanStatus,
  type ScanTrigger,
  type ScanVerdict,
} from "@kept/shared";

import {
  dueScans,
  finishScan,
  insertScan,
  jobRun,
  recentScanFailures,
  reusableScan,
  scanTarget,
  setJobLastDay,
  spikingPages,
  unscannedLiveVersions,
  type DueScan,
  type ScanFinish,
  type ScanTarget,
} from "../db/queries/scans";
import { sendAdminAlert, type AdminAlertOutcome } from "../email/admin-alert";
import { setStatus } from "../moderation/status";
import { MS_PER_DAY, MS_PER_SECOND } from "../sites/display";
import { servingBaseDomain } from "../storage/env";
import { r2Store } from "../storage/r2";
import { withJobRun } from "../visits/sync";

import { defaultClassifier, type ContentClassifier } from "./classifier";
import { extract } from "./extract";
import { decide } from "./policy";
import type { PageFacts, PolicyDecision, PolicyRule } from "./types";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * What one look at a version concluded, before anything is written. `decision`
 * is `null` only when the page could not even be read.
 */
export type Judgment =
  | {
      status: "done";
      decision: PolicyDecision;
      facts: unknown;
      answers: unknown;
      model: string | null;
      /** USD, as `numeric`: `"0"` for a reused verdict. */
      costUsd: string;
    }
  | { status: "skipped"; decision: PolicyDecision; facts: PageFacts }
  | { status: "failed"; decision: PolicyDecision | null; facts: PageFacts | null; error: string };

/** A stored verdict back into the policy's shape. */
function storedDecision(row: { verdict: ScanVerdict | null; rule: string | null; reason: ModerationReason | null }): PolicyDecision {
  if (row.verdict !== "flag") return { verdict: "clean" };
  const rule = row.rule as PolicyRule;
  return { verdict: "flag", reason: row.reason ?? "other", rule, priority: rule === "P2" };
}

/**
 * Steps 2–6 for one version: reuse, read, extract, classify, decide. Writes
 * nothing — `runScan` records it, the CLI's dry run only counts it.
 */
export async function judge(target: ScanTarget, classifier: ContentClassifier | null): Promise<Judgment> {
  let facts: PageFacts | null = null;
  try {
    const reused = await reusableScan(target.contentHash);
    if (reused) {
      return {
        status: "done",
        decision: storedDecision(reused),
        facts: reused.facts,
        answers: reused.answers,
        model: reused.model,
        costUsd: "0",
      };
    }

    const html = await r2Store().get(target.r2Key);
    if (html === null) throw new Error(`no page object at ${target.r2Key}`);
    const extraction = extract(html, `${target.slug}.${servingBaseDomain()}`);
    facts = extraction.facts;

    if (!classifier) return { status: "skipped", decision: decide(facts, null), facts };
    try {
      const result = await classifier.classify(extraction);
      return {
        status: "done",
        decision: decide(facts, result.answers),
        facts,
        answers: result.answers,
        model: result.model,
        costUsd: String(result.cost),
      };
    } catch (err) {
      // Edge case 1: no answers — the deterministic P4 is all that can fire.
      return { status: "failed", decision: decide(facts, null), facts, error: message(err) };
    }
  } catch (err) {
    return { status: "failed", decision: null, facts, error: message(err) };
  }
}

/** When attempt `attempts` failed: the next try, or `null` once the schedule is spent (final). */
export function retryAt(attempts: number, now = Date.now()): Date | null {
  const delay = SCAN_RETRY_DELAYS[attempts - 1];
  return delay === undefined ? null : new Date(now + delay * MS_PER_SECOND);
}

function finishOf(judgment: Judgment, attempts: number): ScanFinish {
  const { decision } = judgment;
  const flag = decision?.verdict === "flag" ? decision : null;
  const verdictFields = {
    // A failed attempt records a verdict only when P4 acted on it.
    verdict: judgment.status === "failed" ? (flag ? ("flag" as const) : null) : (decision?.verdict ?? null),
    rule: flag?.rule ?? null,
    reason: flag?.reason ?? null,
  };
  switch (judgment.status) {
    case "done":
      return {
        status: "done",
        attempts,
        nextAttemptAt: null,
        ...verdictFields,
        model: judgment.model,
        facts: judgment.facts,
        answers: judgment.answers,
        costUsd: judgment.costUsd,
        error: null,
      };
    case "skipped":
      return {
        status: "skipped",
        attempts,
        nextAttemptAt: null,
        ...verdictFields,
        model: null,
        facts: judgment.facts,
        answers: null,
        costUsd: null,
        error: null,
      };
    case "failed":
      return {
        status: "failed",
        attempts,
        nextAttemptAt: retryAt(attempts),
        ...verdictFields,
        model: null,
        facts: judgment.facts,
        answers: null,
        costUsd: null,
        error: judgment.error,
      };
  }
}

/** One attempt's outcome, for the job's counts and the CLI's report. */
export interface ScanRun {
  scanId: string;
  slug: string;
  status: Exclude<ScanStatus, "pending">;
  decision: PolicyDecision | null;
  /** `setStatus` moved the page to `under_review`. */
  flagged: boolean;
}

/** Steps 2–8 on an existing row. Never throws: a failure is the row's `failed`. */
async function settle(scan: DueScan, classifier: ContentClassifier | null): Promise<ScanRun> {
  const attempts = scan.attempts + 1;
  try {
    const judgment = await judge(scan, classifier);
    let flagged = false;
    if (judgment.decision?.verdict === "flag") {
      // D4 lives in `setStatus`: a page no longer live, or a version no longer
      // current (replaced while scanning, edge case 3), is refused there.
      const result = await setStatus(scan.siteId, "under_review", {
        actor: "scanner",
        automated: true,
        reason: judgment.decision.reason,
        scanId: scan.id,
        versionId: scan.versionId,
      });
      flagged = result.ok;
    }
    await finishScan(scan.id, finishOf(judgment, attempts));
    return { scanId: scan.id, slug: scan.slug, status: judgment.status, decision: judgment.decision, flagged };
  } catch (err) {
    const error = message(err);
    console.error(`[kept] scan ${scan.id} of site ${scan.siteId} failed — ${error}`);
    await finishScan(scan.id, finishOf({ status: "failed", decision: null, facts: null, error }, attempts)).catch(
      (writeErr: unknown) => console.error(`[kept] scan ${scan.id}: the failure was not recorded — ${message(writeErr)}`),
    );
    return { scanId: scan.id, slug: scan.slug, status: "failed", decision: null, flagged: false };
  }
}

/**
 * Scan `versionId` of `siteId` now: the row, then steps 2–8. `null` when no row
 * could be written (no such version, or the database refused) — the retry job's
 * unscanned pickup finds that version later. Never throws.
 */
export async function runScan(
  siteId: string,
  versionId: string,
  trigger: ScanTrigger,
  classifier: ContentClassifier | null = defaultClassifier(),
): Promise<ScanRun | null> {
  try {
    const target = await scanTarget(siteId, versionId);
    if (!target) {
      console.error(`[kept] scan: version ${versionId} of site ${siteId} does not exist — nothing to scan`);
      return null;
    }
    const scanId = await insertScan(target, trigger);
    return await settle({ ...target, id: scanId, attempts: 0 }, classifier);
  } catch (err) {
    console.error(`[kept] scan of site ${siteId} version ${versionId} could not start — ${message(err)}`);
    return null;
  }
}

// ── scan-retry (§6.5) ────────────────────────────────────────────────────────

export interface ScanCounts {
  done: number;
  skipped: number;
  failed: number;
  flagged: number;
}

function counter(): ScanCounts & { add(run: ScanRun | null): void } {
  return {
    done: 0,
    skipped: 0,
    failed: 0,
    flagged: 0,
    add(run) {
      if (!run) return;
      this[run.status] += 1;
      if (run.flagged) this.flagged += 1;
    },
  };
}

function counts({ done, skipped, failed, flagged }: ScanCounts): ScanCounts {
  return { done, skipped, failed, flagged };
}

interface Batch {
  /** Epoch ms after which no new scan starts. */
  deadline?: number;
  limit?: number;
}

/** Due `failed` rows (and `pending` rows a dead process left) — run again on the same row. */
export async function retryDueScans(
  classifier: ContentClassifier | null,
  { deadline = Infinity, limit = SCAN_RETRY_BATCH_SIZE }: Batch = {},
): Promise<ScanCounts> {
  const tally = counter();
  for (const scan of await dueScans(limit)) {
    if (Date.now() >= deadline) break;
    tally.add(await settle(scan, classifier));
  }
  return counts(tally);
}

/**
 * Live pages whose current version became current more than
 * `UNSCANNED_GRACE_MINUTES` ago and has no scan at all (the process died before
 * step 1). The trigger that should have run is unknown, so it is `backfill`.
 */
export async function scanUnscanned(
  classifier: ContentClassifier | null,
  { deadline = Infinity, limit = SCAN_RETRY_BATCH_SIZE }: Batch = {},
): Promise<ScanCounts> {
  const tally = counter();
  const before = new Date(Date.now() - UNSCANNED_GRACE_MINUTES * 60_000);
  for (const target of await unscannedLiveVersions(before, limit)) {
    if (Date.now() >= deadline) break;
    tally.add(await runScan(target.siteId, target.versionId, "backfill", classifier));
  }
  return counts(tally);
}

/** The throttle bucket of the failure alert — one mail a day. */
export const SCAN_FAILURE_ALERT_KEY = "scan-failures";

/**
 * More than `SCAN_FAILURE_ALERT_THRESHOLD` failed attempts in 24 h → one admin
 * mail per day naming the last error. `null`: under the threshold. `throttleKey`
 * exists for tests, which must not spend the real day's mail.
 */
export async function alertOnScanFailures(
  throttleKey: string = SCAN_FAILURE_ALERT_KEY,
): Promise<AdminAlertOutcome | null> {
  const { failures, lastError } = await recentScanFailures();
  if (failures <= SCAN_FAILURE_ALERT_THRESHOLD) return null;
  return sendAdminAlert({
    subject: `${failures} page scans failed in the last 24 hours`,
    lines: [
      `${failures} scan attempts failed in the last 24 hours (the alert threshold is ${SCAN_FAILURE_ALERT_THRESHOLD}).`,
      `The last error: ${lastError ?? "(none recorded)"}`,
      "Pages stay live while their scans retry (+5 min, +15 min, +1 h, +6 h, +24 h). A 402 credit_limit means the OpenRouter key's monthly limit is spent.",
    ],
    throttleKey,
    throttle: SCAN_FAILURE_ALERT_DAY,
  });
}

// ── the spike check (§6.12) ──────────────────────────────────────────────────

/** The two `job_runs` keys the spike check reads and writes. Tests pass their own. */
export const SPIKE_JOBS = { sync: "visits-sync", check: "spike-check" } as const;

/** D: the last complete UTC day before the visits sync's last success, `YYYY-MM-DD`. */
export function spikeDay(syncedAt: Date): string {
  const midnight = Date.UTC(syncedAt.getUTCFullYear(), syncedAt.getUTCMonth(), syncedAt.getUTCDate());
  return new Date(midnight - MS_PER_DAY).toISOString().slice(0, 10);
}

/** `day: null` — the visits sync never succeeded. `scanned: null` — D was already checked. */
export interface SpikeCheck {
  day: string | null;
  scanned: number | null;
}

/**
 * Once per synced day: pages whose visits spiked on D are re-scanned (trigger
 * `traffic_spike`). A spike alone changes no status — only the scan can, as any
 * scan can. Not in the visits sync (E06 AC35 freezes it), which also makes a
 * manual `?days=30` re-sync harmless: the same D maps to the same checked day.
 */
export async function checkSpikes(
  classifier: ContentClassifier | null,
  jobs: { sync: string; check: string } = SPIKE_JOBS,
): Promise<SpikeCheck> {
  const synced = await jobRun(jobs.sync);
  if (!synced?.lastSuccessAt) return { day: null, scanned: null };
  const day = spikeDay(synced.lastSuccessAt);
  if ((await jobRun(jobs.check))?.lastDay === day) return { day, scanned: null };

  return withJobRun(jobs.check, async () => {
    let scanned = 0;
    for (const page of await spikingPages(day)) {
      await runScan(page.siteId, page.versionId, "traffic_spike", classifier);
      scanned += 1;
    }
    await setJobLastDay(jobs.check, day);
    return { day, scanned };
  });
}

export interface ScanRetryResult {
  retried: ScanCounts;
  unscanned: ScanCounts;
  alert: AdminAlertOutcome | null;
  spikes: SpikeCheck;
}

/** `scan-retry`'s `job_runs` key — the moderation screen's Scanner tab reads it too. */
export const SCAN_RETRY_JOB = "scan-retry";

/** The whole `scan-retry` job, recorded in `job_runs` as `SCAN_RETRY_JOB`. */
export function runScanRetry(classifier: ContentClassifier | null = defaultClassifier()): Promise<ScanRetryResult> {
  return withJobRun(SCAN_RETRY_JOB, async () => {
    const deadline = Date.now() + JOB_DEADLINE_SECONDS * MS_PER_SECOND;
    const retried = await retryDueScans(classifier, { deadline });
    const unscanned = await scanUnscanned(classifier, { deadline });
    const alert = await alertOnScanFailures();
    const spikes = await checkSpikes(classifier);
    return { retried, unscanned, alert, spikes };
  });
}
