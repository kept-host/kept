/**
 * A profile change every kept page's badge shows — the handle (008), the badge
 * style (009) — re-syncs those pages through the `repurge` job, never inline
 * (E10 Q4). A Pro account can hold 1,000 kept pages, and each sync is a KV
 * write: inline, one save would be a request that runs for minutes and spends a
 * day of dev's KV quota. So the handler queues one `pending_purges` row per
 * page (`urls: []`, due now) in one statement, and the next `repurge` run
 * replays each as `syncManifest(site)` and its double purge.
 *
 * Call it AFTER the profile change commits: a replay that ran first would
 * write the old badge again.
 */
import { enqueueOwnerSyncs } from "../db/queries/manifest-sync";

/** Queue a re-sync of every kept page `profileId` owns that the edge serves. Returns how many were queued. */
export function resyncOwnerPages(profileId: string): Promise<number> {
  return enqueueOwnerSyncs(profileId);
}
