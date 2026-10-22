/**
 * The rows `syncManifest` and the `repurge` job read and write (E07 D18, §6.14).
 *
 * Two concerns, both owned by `lib/storage/manifest.ts` and `lib/storage/repurge.ts`
 * and kept here so no SQL lives in a store helper or a route handler:
 *
 *   - `lockSiteForSync` — the site row, locked `FOR UPDATE`, with exactly the
 *     columns a manifest is built from (the current version's `spa`/`has_404`
 *     included). Not owner-scoped: the sync serves every writer (owner, token
 *     holder, moderation, expiry) and decides nothing but what the edge must say.
 *   - `pending_purges` — the durable half of the double purge. A row is written
 *     before the in-process re-purge is scheduled and deleted when it lands; a
 *     failed purge or a failed manifest write leaves one due now.
 */
import { REPURGE_MAX_ATTEMPTS } from "@kept/shared";
import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm";

import { db, type Tx } from "../index";
import { pendingPurges, sites, siteVersions } from "../schema";

import { versionPaths } from "./version-files";

/**
 * The site row as a manifest needs it, locked until `tx` ends. `null` when the
 * row does not exist (a hard-deleted page — the sync has nothing to say).
 *
 * `spa` / `has404` are the current version's (E08 D12, D13), `false` when it has
 * no row. Only the site row is locked (`OF sites`): Postgres refuses `FOR UPDATE`
 * on the nullable side of an outer join, and a version row never changes.
 */
export async function lockSiteForSync(tx: Tx, siteId: string) {
  const [site] = await tx
    .select({
      id: sites.id,
      slug: sites.slug,
      status: sites.status,
      currentVersionId: sites.currentVersionId,
      ownerId: sites.ownerId,
      region: sites.region,
      spa: siteVersions.spa,
      has404: siteVersions.has404,
    })
    .from(sites)
    .leftJoin(siteVersions, eq(siteVersions.id, sites.currentVersionId))
    .where(eq(sites.id, siteId))
    .for("update", { of: sites });
  return site ? { ...site, spa: site.spa === true, has404: site.has404 === true } : null;
}

/**
 * The paths of the version `siteId` serves now, from `site_version_files` (E08
 * D1, never an R2 list). `[]` when the site or its current version is gone.
 */
export async function currentVersionPaths(siteId: string, handle: Tx | typeof db = db): Promise<string[]> {
  const [site] = await handle
    .select({ versionId: sites.currentVersionId })
    .from(sites)
    .where(eq(sites.id, siteId));
  if (!site?.versionId) return [];
  return (await versionPaths(handle, [site.versionId])).get(site.versionId) ?? [];
}

export type PendingPurge = typeof pendingPurges.$inferSelect;

export interface PendingPurgeInput {
  /** Set when the purge belongs to a known site: the replay re-syncs it first. */
  siteId: string | null;
  slug: string;
  urls: readonly string[];
  dueAt: Date;
}

/** Record a purge that is still owed — on `tx` when given. Returns the row id. */
export async function insertPendingPurge(input: PendingPurgeInput, tx: Tx | typeof db = db): Promise<string> {
  const [row] = await tx
    .insert(pendingPurges)
    .values({ siteId: input.siteId, slug: input.slug, urls: [...input.urls], dueAt: input.dueAt })
    .returning({ id: pendingPurges.id });
  if (!row) throw new Error(`pending_purges insert for slug "${input.slug}" returned no row`);
  return row.id;
}

/** The purge landed: nothing is owed any more. */
export async function deletePendingPurge(id: string): Promise<void> {
  await db.delete(pendingPurges).where(eq(pendingPurges.id, id));
}

/**
 * Up to `limit` rows due now that have not given up, oldest due first. A row
 * that has used its `REPURGE_MAX_ATTEMPTS` stays in the table for a human to
 * read and is never selected again.
 *
 * `scope` limits the batch to the given row ids. Only the drills pass it: the
 * dev table is shared, and an unscoped replay would replay every other run's
 * rows (the same fence as `lib/db/queries/lifecycle.ts`).
 */
export async function duePendingPurges(limit: number, scope?: readonly string[]): Promise<PendingPurge[]> {
  return db
    .select()
    .from(pendingPurges)
    .where(
      and(
        lte(pendingPurges.dueAt, sql`now()`),
        lt(pendingPurges.attempts, REPURGE_MAX_ATTEMPTS),
        scope ? inArray(pendingPurges.id, [...scope]) : undefined,
      ),
    )
    .orderBy(asc(pendingPurges.dueAt))
    .limit(limit);
}

/**
 * A replay re-synced the site: what the row still owes is the SECOND purge of
 * the write that sync just made, no earlier than `dueAt`. It stops naming the
 * site, so its next replay is a purge and not another manifest write.
 */
export async function owePurgeOnly(id: string, urls: readonly string[], dueAt: Date): Promise<void> {
  await db
    .update(pendingPurges)
    .set({ siteId: null, urls: [...urls], dueAt })
    .where(eq(pendingPurges.id, id));
}

/**
 * Not yet, or now: move the rows' due time without counting an attempt — on `tx`
 * when given (rows `syncManifest` wrote in its own, still-open transaction).
 */
export async function deferPendingPurges(
  ids: readonly string[],
  dueAt: Date,
  tx: Tx | typeof db = db,
): Promise<void> {
  if (ids.length === 0) return;
  await tx.update(pendingPurges).set({ dueAt }).where(inArray(pendingPurges.id, [...ids]));
}

/**
 * A replay failed: count it, keep the error, retry no earlier than `retryAt`.
 * Returns the attempts used so far.
 */
export async function recordPendingPurgeFailure(
  id: string,
  error: string,
  retryAt: Date,
): Promise<number> {
  const [row] = await db
    .update(pendingPurges)
    .set({ attempts: sql`${pendingPurges.attempts} + 1`, lastError: error, dueAt: retryAt })
    .where(eq(pendingPurges.id, id))
    .returning({ attempts: pendingPurges.attempts });
  return row?.attempts ?? REPURGE_MAX_ATTEMPTS;
}
