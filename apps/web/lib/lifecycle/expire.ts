/**
 * The `expire` job (E07 §6.13, D14, AC23): every `live` draft past its
 * `expires_at` becomes `expired`, and the edge says so — "This draft wasn't
 * kept", the 410 the Worker has served for `expired` since E03 and nothing wrote
 * until now.
 *
 * Per site, never per batch (Risk 12): `lockOwner` when the page is owned (the
 * late keep takes it too, edge case 13) → the site row → re-check under both
 * locks (still `live`, still past its clock) → `status = 'expired'` → commit →
 * `syncManifest`, which writes the `expired` manifest from the row. A keep that
 * committed first leaves nothing to expire; a keep that waits finds `expired`
 * and is a late keep. Kept pages have no clock and flagged drafts are not
 * `live`, so neither is ever a candidate (edge case 15).
 *
 * Batched (`EXPIRE_BATCH_SIZE`) through `sites_live_expires_idx`, bounded by
 * `JOB_DEADLINE_SECONDS`, idempotent: an expired page leaves the candidate set,
 * so a second run finds nothing.
 */
import { EXPIRE_BATCH_SIZE, JOB_DEADLINE_SECONDS } from "@kept/shared";

import { db } from "../db";
import { dueExpiries, markExpired } from "../db/queries/lifecycle";
import { lockSiteForModeration, readSiteOwner } from "../db/queries/moderation";
import { MS_PER_SECOND } from "../sites/display";
import { lockOwner } from "../sites/keep";
import { syncManifest } from "../storage/manifest";
import { withJobRun } from "../visits/sync";

export type ExpireOutcome = "expired" | "skipped" | "failed";

export type ExpireCounts = Record<ExpireOutcome, number>;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Expire one draft if it is still due, under the locks. Never throws.
 *
 * `skipped`: no longer due (kept, flagged, already expired, gone) or its owner
 * changed between the read and the lock — the next run re-reads it.
 */
export async function expireSite(siteId: string): Promise<ExpireOutcome> {
  let moved: boolean;
  try {
    moved = await db.transaction(async (tx) => {
      const ownerId = await readSiteOwner(tx, siteId);
      if (ownerId === undefined) return false;
      if (ownerId) await lockOwner(tx, ownerId);
      const site = await lockSiteForModeration(tx, siteId);
      if (!site || site.ownerId !== ownerId) return false;
      if (site.status !== "live" || site.expiresAt === null || site.expiresAt >= new Date()) return false;
      await markExpired(tx, siteId);
      return true;
    });
  } catch (err) {
    console.error(`[kept] expire: site ${siteId} could not be expired — ${message(err)}. The next run retries.`);
    return "failed";
  }
  if (!moved) return "skipped";

  // After the commit, in its own transaction (D18). A failure is the repurge
  // job's row; the page is `expired` either way.
  const synced = await syncManifest(siteId);
  if (!synced.ok) {
    console.error(`[kept] expire: site ${siteId} is expired but its manifest sync failed — ${synced.error}.`);
  }
  return "expired";
}

/**
 * The sweep: due drafts in batches until none are left, the deadline passes, or
 * a batch moves nothing (whatever is left is failing or changing under it, and
 * the next run tries again). `scope` is the drills' fence — see
 * `lib/db/queries/lifecycle.ts`.
 */
export async function expireDue(scope?: readonly string[]): Promise<ExpireCounts> {
  const deadline = Date.now() + JOB_DEADLINE_SECONDS * MS_PER_SECOND;
  const counts: ExpireCounts = { expired: 0, skipped: 0, failed: 0 };

  while (Date.now() < deadline) {
    const ids = await dueExpiries(EXPIRE_BATCH_SIZE, scope);
    if (ids.length === 0) break;
    let progressed = false;
    for (const id of ids) {
      if (Date.now() >= deadline) break;
      const outcome = await expireSite(id);
      counts[outcome] += 1;
      if (outcome === "expired") progressed = true;
    }
    if (!progressed) break;
  }
  return counts;
}

/** The whole job, recorded in `job_runs` as `expire`. */
export function runExpire(): Promise<ExpireCounts> {
  return withJobRun("expire", () => expireDue());
}
