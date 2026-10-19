/**
 * Teardown help for every drill that leaves pages at the edge. Test-only:
 * nothing in the app imports it, and its name keeps it outside the unit-test
 * glob.
 *
 * Dev KV is on the free plan (1k deletes a day). A page the drill archived,
 * removed or purged has already left the edge — its own path removed the
 * manifest (D18) — and a name a rename gave up was removed by the rename.
 * Removing either again spends a KV delete, a pointer delete and two purges on
 * a key that is not there. So a teardown removes only the slugs a row still
 * answers to: a version, and a status the Worker serves from a manifest.
 *
 * Call it BEFORE deleting the rows — it reads them.
 */
import { and, inArray, isNotNull, notInArray } from "drizzle-orm";

import { db } from "../db";
import { sites } from "../db/schema";
import { removeManifest } from "../storage/manifest";

/** The statuses with no manifest — `syncManifest` removes it (`lib/storage/manifest.ts`). */
export const UNSERVED_STATUSES = ["removed", "archived"] as const;

export async function removeServedManifests(slugs: Iterable<string>): Promise<void> {
  const names = [...slugs];
  if (names.length === 0) return;
  const served = await db
    .selectDistinct({ slug: sites.slug })
    .from(sites)
    .where(
      and(
        inArray(sites.slug, names),
        notInArray(sites.status, [...UNSERVED_STATUSES]),
        isNotNull(sites.currentVersionId),
      ),
    );
  for (const { slug } of served) await removeManifest(slug).catch(() => undefined);
}
