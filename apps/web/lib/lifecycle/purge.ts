/**
 * The `purge` job (E07 §6.13, D14, AC24): the hard delete every soft end has
 * been promising since E04. A page past `purge_after` in a purgeable status
 * (`PURGEABLE_STATUSES`), with no open appeal (edge case 24), loses its name,
 * its manifest, its bytes and its row.
 *
 * Per site, in ONE transaction, never per batch (Risk 12):
 *
 *   lockOwner (owned pages) → the site row → re-check (still due, no open appeal)
 *   → take up to the run's remaining delete budget of its `site_version_files`
 *     rows (E08 D1 — every file of every version; never an R2 list)
 *   → if rows remain past the budget (E08 Q2): delete the taken objects
 *     (`deleteMany`) and COMMIT — `partial`: the row, its name, its manifest and
 *     the untaken file rows stay, and the next run resumes
 *   → releaseName — NOT for `removed`, whose ownerless D19 hold must outlive
 *     the page (releaseName would upsert a `purged` hold back to its owner)
 *   → removeManifest — unless another page claims the slug now (an archived
 *     or removed row released it; that manifest is the other page's)
 *   → the taken objects, in `deleteMany` (a missing object is not an error)
 *   → the row (versions, scans, appeals cascade; the moderation log and reports
 *     keep theirs with `site_id` NULL and the slug)
 *   COMMIT
 *
 * A store failure throws inside the transaction, so the row, its name and its
 * file rows stay and the next run retries; every step is safe to repeat. A
 * `partial` page is past `purge_after` in a status the edge never serves bytes
 * for, so deleting part of its files first changes nothing a visitor sees. A
 * late keep waits on `lockOwner` and then finds no row, or commits first and
 * the re-check finds nothing to purge (edge case 13) — never a half-deleted
 * page.
 *
 * The run stops after `PURGE_DELETES_PER_RUN` objects, so the locks are never
 * held across more than two `DeleteObjects` requests and the deadline holds
 * however many files a page has.
 *
 * Then, once per run, reporters' names and emails are cleared
 * `REPORTER_CONTACT_RETENTION_DAYS` after their report was resolved.
 */
import { JOB_DEADLINE_SECONDS, PURGE_BATCH_SIZE, PURGE_DELETES_PER_RUN } from "@kept/shared";

import { db } from "../db";
import {
  clearResolvedReporterContacts,
  deleteSiteRow,
  duePurges,
  hasOpenAppeal,
  PURGEABLE_STATUSES,
} from "../db/queries/lifecycle";
import { lockSiteForModeration, readSiteOwner, slugClaimedByAnother } from "../db/queries/moderation";
import { takeSiteObjectKeys } from "../db/queries/version-files";
import { releaseName } from "../names/holds";
import { MS_PER_SECOND } from "../sites/display";
import { lockOwner } from "../sites/keep";
import { removeManifest } from "../storage/manifest";
import { r2Store } from "../storage/r2";
import { withJobRun } from "../visits/sync";

export type PurgeOutcome = "purged" | "partial" | "skipped" | "failed";

/** What one `purgeSite` did, and how many R2 objects it deleted. */
export interface PurgeResult {
  outcome: PurgeOutcome;
  deleted: number;
}

export type PurgeCounts = Record<PurgeOutcome, number> & { reporterContactsCleared: number };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPurgeable(site: { status: string; purgeAfter: Date | null }, now: Date): boolean {
  return (
    (PURGEABLE_STATUSES as readonly string[]).includes(site.status) &&
    site.purgeAfter !== null &&
    site.purgeAfter < now
  );
}

/**
 * Purge one page if it is still due, under the locks, deleting at most
 * `deleteBudget` R2 objects. Never throws.
 *
 * `partial`: the budget ran out first — the row stays and the next run resumes.
 * `skipped`: already gone (a second run), no longer due (kept, restored,
 * appealed), or its owner changed between the read and the lock.
 */
export async function purgeSite(siteId: string, deleteBudget: number = PURGE_DELETES_PER_RUN): Promise<PurgeResult> {
  const skipped: PurgeResult = { outcome: "skipped", deleted: 0 };
  try {
    return await db.transaction(async (tx): Promise<PurgeResult> => {
      const ownerId = await readSiteOwner(tx, siteId);
      if (ownerId === undefined) return skipped;
      if (ownerId) await lockOwner(tx, ownerId);
      const site = await lockSiteForModeration(tx, siteId);
      if (!site || site.ownerId !== ownerId) return skipped;
      if (!isPurgeable(site, new Date()) || (await hasOpenAppeal(tx, siteId))) return skipped;

      const r2 = r2Store();
      const { keys, rest } = await takeSiteObjectKeys(tx, siteId, deleteBudget);
      if (rest) {
        await r2.deleteMany(keys);
        return { outcome: "partial", deleted: keys.length };
      }

      if (site.status !== "removed") await releaseName(siteId, tx);

      if (!(await slugClaimedByAnother(tx, site.slug, site.id))) {
        const removed = await removeManifest(site.slug, site.id);
        if (!removed.ok) throw new Error(`manifest removal failed at the "${removed.step}" step — ${removed.error}`);
      }

      await r2.deleteMany(keys);
      await deleteSiteRow(tx, siteId);
      return { outcome: "purged", deleted: keys.length };
    });
  } catch (err) {
    console.error(
      `[kept] purge: site ${siteId} was not purged — ${message(err)}. Nothing was committed; the next run retries.`,
    );
    return { outcome: "failed", deleted: 0 };
  }
}

/**
 * The sweep: due pages in batches until none are left, the deadline passes,
 * `PURGE_DELETES_PER_RUN` objects are deleted, or a batch purges nothing; then
 * the reporter-contact clearing. `scope` is the drills' fence — see
 * `lib/db/queries/lifecycle.ts` — and also fences the clearing off: a scoped
 * drill touches no report it did not make.
 */
export async function purgeDue(scope?: readonly string[]): Promise<PurgeCounts> {
  const deadline = Date.now() + JOB_DEADLINE_SECONDS * MS_PER_SECOND;
  const counts: PurgeCounts = { purged: 0, partial: 0, skipped: 0, failed: 0, reporterContactsCleared: 0 };
  let deleteBudget: number = PURGE_DELETES_PER_RUN;

  while (Date.now() < deadline && deleteBudget > 0) {
    const ids = await duePurges(PURGE_BATCH_SIZE, scope);
    if (ids.length === 0) break;
    let progressed = false;
    for (const id of ids) {
      if (Date.now() >= deadline || deleteBudget <= 0) break;
      const { outcome, deleted } = await purgeSite(id, deleteBudget);
      counts[outcome] += 1;
      deleteBudget -= deleted;
      if (outcome === "purged") progressed = true;
    }
    if (!progressed) break;
  }

  if (!scope) counts.reporterContactsCleared = await clearResolvedReporterContacts();
  return counts;
}

/** The whole job, recorded in `job_runs` as `purge`. */
export function runPurge(): Promise<PurgeCounts> {
  return withJobRun("purge", () => purgeDue());
}
