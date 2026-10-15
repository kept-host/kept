/**
 * Teardown help for the moderation drills (`lib/moderation/*.test.ts`) — E07
 * task 004. Test-only: nothing in the app imports it, and its name keeps it
 * outside the unit-test glob.
 *
 * Dev KV is on the free plan (1k deletes a day), so a drill removes only the
 * manifests it actually caused: a page whose status a committed `setStatus`
 * changed (it has a `moderation_actions` row, so `syncManifest` ran) and that
 * is still served (not `removed` / `archived`, which the sync already removed).
 */
import { and, inArray, notInArray } from "drizzle-orm";

import { db } from "../db";
import { moderationActions, sites } from "../db/schema";

export async function stillServed(siteIds: string[]): Promise<string[]> {
  const synced = db
    .selectDistinct({ id: moderationActions.siteId })
    .from(moderationActions)
    .where(inArray(moderationActions.siteId, siteIds));
  const rows = await db
    .select({ slug: sites.slug })
    .from(sites)
    .where(and(inArray(sites.id, synced), notInArray(sites.status, ["removed", "archived"])));
  return rows.map((row) => row.slug);
}
