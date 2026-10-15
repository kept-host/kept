/**
 * The `repurge` job (E07 §6.14, AC26, AC35): replay every `pending_purges` row
 * that is due — the second purges a restart lost, the first purges Cloudflare
 * refused, and the manifest syncs whose KV write failed.
 *
 * A row that names a site is re-synced FIRST (`syncManifestForReplay`), so the
 * edge converges on the row as it stands now — not on whatever state the failed
 * write was carrying — and then purged. That sync is a fresh KV write, which
 * owes its own delayed second purge, so the row is kept for exactly that
 * (`owePurgeOnly`) instead of deleted. A row that names no site is a purge:
 * deleted once it lands, unless the KV write it follows is too recent for one
 * purge to be enough (then it waits until it is).
 *
 * Failures count against `REPURGE_MAX_ATTEMPTS`; a row that uses them stays in
 * the table, is never selected again, and is reported in ONE admin alert per
 * run. Batched, bounded by `JOB_DEADLINE_SECONDS`, and idempotent: every row it
 * touches leaves the due set (deleted, or due later), so a second run right
 * after the first finds nothing.
 */
import {
  JOB_DEADLINE_SECONDS,
  REPURGE_BATCH_SIZE,
  REPURGE_MAX_ATTEMPTS,
} from "@kept/shared";

import {
  deferPendingPurge,
  deletePendingPurge,
  duePendingPurges,
  owePurgeOnly,
  recordPendingPurgeFailure,
  type PendingPurge,
} from "../db/queries/manifest-sync";
import { sendAdminAlert } from "../email/admin-alert";
import { withJobRun } from "../visits/sync";

import { KV_REPURGE_DELAY_MS, slugPurgeUrls, syncManifestForReplay } from "./manifest";
import { purgeUrls } from "./purge";

export type ReplayOutcome = "synced" | "purged" | "deferred" | "failed" | "gave_up";

export type RepurgeCounts = Record<ReplayOutcome, number>;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The row's URLs, or — recorded without them — the slug's two forms. */
function urlsOf(row: PendingPurge): string[] {
  const urls = row.urls as string[];
  if (urls.length > 0 || row.slug === "") return urls;
  return slugPurgeUrls(row.slug);
}

/** One more failed attempt: retried after the propagation window, or given up. */
async function failed(row: PendingPurge, error: string): Promise<ReplayOutcome> {
  console.error(`[kept] repurge: replay of slug "${row.slug}" (row ${row.id}) failed — ${error}`);
  const attempts = await recordPendingPurgeFailure(
    row.id,
    error,
    new Date(Date.now() + KV_REPURGE_DELAY_MS),
  );
  return attempts >= REPURGE_MAX_ATTEMPTS ? "gave_up" : "failed";
}

/** Replay one due row. Never throws: a failure is counted on the row. */
export async function replayPendingPurge(row: PendingPurge): Promise<ReplayOutcome> {
  try {
    let urls = urlsOf(row);
    let resynced = false;

    if (row.siteId) {
      const synced = await syncManifestForReplay(row.siteId);
      if (!synced.ok) return await failed(row, `sync: ${synced.error}`);
      if (synced.slug !== undefined) {
        urls = [...new Set([...urls, ...slugPurgeUrls(synced.slug)])];
        resynced = true;
      }
    }

    const purged = await purgeUrls(urls);
    if (!purged.ok) return await failed(row, `purge: ${purged.error}`);

    if (resynced) {
      await owePurgeOnly(row.id, urls, new Date(Date.now() + KV_REPURGE_DELAY_MS));
      return "synced";
    }

    // One purge suffices only once the edge's KV read cache can no longer hold
    // the manifest from before the write this row follows.
    const settledAt = row.createdAt.getTime() + KV_REPURGE_DELAY_MS;
    if (Date.now() < settledAt) {
      await deferPendingPurge(row.id, new Date(settledAt));
      return "deferred";
    }
    await deletePendingPurge(row.id);
    return "purged";
  } catch (err) {
    return failed(row, message(err));
  }
}

/** The whole job: due rows in batches until none are left or the deadline. */
export function replayDuePurges(): Promise<RepurgeCounts> {
  return withJobRun("repurge", async () => {
    const deadline = Date.now() + JOB_DEADLINE_SECONDS * 1000;
    const counts: RepurgeCounts = { synced: 0, purged: 0, deferred: 0, failed: 0, gave_up: 0 };
    const gaveUp: PendingPurge[] = [];

    while (Date.now() < deadline) {
      const rows = await duePendingPurges(REPURGE_BATCH_SIZE);
      if (rows.length === 0) break;
      for (const row of rows) {
        if (Date.now() >= deadline) break;
        const outcome = await replayPendingPurge(row);
        counts[outcome] += 1;
        if (outcome === "gave_up") gaveUp.push(row);
      }
    }

    if (gaveUp.length > 0) {
      await sendAdminAlert({
        subject: `${gaveUp.length} edge purge(s) gave up after ${REPURGE_MAX_ATTEMPTS} attempts`,
        lines: [
          "These pages may be serving a stale copy at the edge. Their pending_purges rows stay in the table with the last error; fix the cause, then reset `attempts` to replay them.",
          ...gaveUp.map((row) => `${row.slug || "(no slug)"} — site ${row.siteId ?? "none"}, row ${row.id}`),
        ],
      });
    }
    return counts;
  });
}
