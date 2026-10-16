/**
 * Teardown help for every drill that writes or removes a manifest (E07 task
 * 012). Test-only: nothing in the app imports it, and its name keeps it outside
 * the unit-test glob.
 *
 * Every manifest write leaves a `pending_purges` row until its in-process
 * second purge lands, 125 s later (`lib/storage/manifest.ts`). A test process —
 * a `tsx --test` file, a Playwright worker, a dev server Playwright stops —
 * exits long before that, so without this each run leaves its rows in dev for
 * the `repurge` job to replay: a manifest rewrite for any page still standing,
 * a purge for each of the rest, and an admin alert for every one that fails.
 *
 * So a drill drops the rows ITS pages left, by slug (every row carries one) and
 * by site id (a sync failure's row names the site). Call it AFTER the drill's
 * own `removeManifest` calls, which write rows of their own. The edge cost is
 * the one the drills always had before the rows existed: the second purge of a
 * test page that is gone either way.
 */
import { inArray, or } from "drizzle-orm";

import { db } from "../db";
import { pendingPurges } from "../db/schema";

export async function clearPendingPurges(slugs: Iterable<string>, siteIds: Iterable<string> = []): Promise<void> {
  const names = [...slugs];
  const ids = [...siteIds];
  const owned = [
    ...(names.length > 0 ? [inArray(pendingPurges.slug, names)] : []),
    ...(ids.length > 0 ? [inArray(pendingPurges.siteId, ids)] : []),
  ];
  if (owned.length === 0) return;
  await db.delete(pendingPurges).where(or(...owned));
}
