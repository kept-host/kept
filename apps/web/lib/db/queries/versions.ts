/**
 * Every SQL statement about a page's version history (D7) — E06 task 007.
 *
 * ⚠️ `site_id` IS IN EVERY WHERE CLAUSE. A version id is a bare uuid in a URL
 * path; a statement keyed by it alone would let one page restore, list or prune
 * another page's version. Scoped by `site_id`, a foreign version is simply not
 * found.
 *
 * Ordering is `activated_at` (when a version last became the served one), then
 * `created_at` as the tie-break. Replace stamps it on insert and restore stamps
 * it again, so "newest" means "most recently live", which is the order both the
 * Versions list and pruning need.
 */
import { limitsFor, type PublishChannel } from "@kept/shared";
import { and, desc, eq, ne, sql } from "drizzle-orm";

import { db, type Tx } from "../index";
import { profiles, sites, siteVersions } from "../schema";
import { versionFileKeys } from "./version-files";

const NEWEST_FIRST = [desc(siteVersions.activatedAt), desc(siteVersions.createdAt)] as const;

/** One row of the Versions tab (task 012 renders it). */
export interface VersionListItem {
  id: string;
  createdAt: Date;
  activatedAt: Date;
  /** The version's set total (E08). */
  sizeBytes: number;
  /** How many files the version holds (E08) — "{n} files · {size}". */
  fileCount: number;
  /** Its "single-page app" flag (D12): the replace checkbox starts from the current one's. */
  spa: boolean;
  publishedVia: PublishChannel;
  isCurrent: boolean;
}

/**
 * A page's versions, newest first — the current one, then the previous ones.
 *
 * Owner-scoped in the SQL: another account's page lists nothing, exactly as a
 * page that does not exist does. Rows past the plan's limit (a downgrade, or a
 * prune whose R2 delete failed) are listed while they exist — each one is still
 * restorable.
 */
export async function listVersions(siteId: string, ownerId: string): Promise<VersionListItem[]> {
  const rows = await db
    .select({
      id: siteVersions.id,
      createdAt: siteVersions.createdAt,
      activatedAt: siteVersions.activatedAt,
      sizeBytes: siteVersions.sizeBytes,
      fileCount: siteVersions.fileCount,
      spa: siteVersions.spa,
      publishedVia: siteVersions.publishedVia,
      currentVersionId: sites.currentVersionId,
    })
    .from(siteVersions)
    .innerJoin(sites, eq(sites.id, siteVersions.siteId))
    .where(and(eq(siteVersions.siteId, siteId), eq(sites.ownerId, ownerId)))
    .orderBy(...NEWEST_FIRST);

  return rows.map(({ currentVersionId, ...version }) => ({
    ...version,
    isCurrent: version.id === currentVersionId,
  }));
}

/** A version as restore and prune need it: where its bytes are, and what they are. */
export interface StoredVersion {
  id: string;
  r2Key: string;
  contentHash: string;
  sizeBytes: number;
  activatedAt: Date;
}

const STORED_VERSION_COLUMNS = {
  id: siteVersions.id,
  r2Key: siteVersions.r2Key,
  contentHash: siteVersions.contentHash,
  sizeBytes: siteVersions.sizeBytes,
  activatedAt: siteVersions.activatedAt,
} as const;

/** One version of one site, or `null` — a version of ANOTHER site is `null` too. */
export async function findSiteVersion(
  tx: Tx,
  siteId: string,
  versionId: string,
): Promise<StoredVersion | null> {
  const [version] = await tx
    .select(STORED_VERSION_COLUMNS)
    .from(siteVersions)
    .where(and(eq(siteVersions.id, versionId), eq(siteVersions.siteId, siteId)));
  return version ?? null;
}

/**
 * Set a version's `activated_at` — to `now()` when it becomes the served one
 * (restore), or back to the value it had when a restore is unwound.
 *
 * `now()` is Postgres's clock, the same one the column default stamps a new
 * version with, so a restore right after a replace can never sort before it on
 * a skew between this process and the database.
 */
export async function stampActivated(
  tx: Tx,
  siteId: string,
  versionId: string,
  at: Date | "now",
): Promise<void> {
  await tx
    .update(siteVersions)
    .set({ activatedAt: at === "now" ? sql`now()` : at })
    .where(and(eq(siteVersions.id, versionId), eq(siteVersions.siteId, siteId)));
}

/** A version a prune drops: its id, and every R2 key its files occupy. */
export interface PrunableVersion {
  id: string;
  keys: string[];
}

/**
 * The versions a prune should drop: everything older than the current one plus
 * the newest `limitsFor(plan).previousVersions` (D7), with the SITE ROW LOCKED
 * `FOR UPDATE` until `tx` ends — each with every file key it owns (E08 D1, from
 * `site_version_files`, never an R2 list).
 *
 * The lock is what makes "R2 delete, then row" safe against a restore: restore
 * takes the same lock (`lockSiteForOwner`), so it can never point the page at a
 * version whose bytes a concurrent prune is deleting. The plan is the owner's
 * plan NOW, read in the same statement — so a downgrade prunes nothing until the
 * next replace (edge case 8). A page with NO owner (an anonymous draft) prunes
 * like `free` (E08 Q-new-4, Arun 2026-10-22): its replace governor allows dozens
 * of versions an hour, and nothing else would ever collect them before
 * `purge_after`.
 */
export async function lockPrunableVersions(tx: Tx, siteId: string): Promise<PrunableVersion[]> {
  const [site] = await tx
    .select({ currentVersionId: sites.currentVersionId, plan: profiles.plan })
    .from(sites)
    .leftJoin(profiles, eq(profiles.id, sites.ownerId))
    .where(eq(sites.id, siteId))
    .for("update", { of: sites });
  if (!site?.currentVersionId) return [];

  const rows = await tx
    .select({ id: siteVersions.id })
    .from(siteVersions)
    .where(and(eq(siteVersions.siteId, siteId), ne(siteVersions.id, site.currentVersionId)))
    .orderBy(...NEWEST_FIRST)
    .offset(limitsFor(site.plan ?? "free").previousVersions);

  const prunable: PrunableVersion[] = [];
  for (const { id } of rows) prunable.push({ id, keys: await versionFileKeys(tx, siteId, [id]) });
  return prunable;
}

/** Drop one version row (its `site_version_files` cascade). Called only after its R2 objects are gone. */
export async function deleteVersionRow(tx: Tx, siteId: string, versionId: string): Promise<void> {
  await tx
    .delete(siteVersions)
    .where(and(eq(siteVersions.id, versionId), eq(siteVersions.siteId, siteId)));
}
