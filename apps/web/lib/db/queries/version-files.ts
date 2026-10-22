/**
 * Every SQL statement about a version's files (E08 D1) — the only module that
 * reads or writes `site_version_files`.
 *
 * The table is the authority on what objects a version owns: the purge job,
 * pruning, the replace unwind, download, export, the scanner and purge-on-
 * replace all enumerate a version through here, never through an R2 `list`
 * (contract §7.5). R2 keys are built with `siteObjectKey`, the one place the
 * layout is spelled.
 *
 * Every function takes the handle it runs on, so a caller holding a row lock
 * passes its transaction and the read sees what the lock protects.
 */
import { and, asc, eq, inArray } from "drizzle-orm";

import { siteObjectKey } from "../../storage/r2";
import type { db, Tx } from "../index";
import { type SiteVersionFile, siteVersionFiles, siteVersions } from "../schema";

type Handle = Tx | typeof db;

/** One file of a set, as stored: its path, byte length and SHA-256 (hex). */
export type VersionFileEntry = Omit<SiteVersionFile, "versionId">;

/**
 * Rows per INSERT. Four parameters a row keeps a chunk at 4,000 bind
 * parameters, far under Postgres's 65,535, so a 5,000-file set is five
 * statements.
 */
const INSERT_CHUNK_ROWS = 1000;

/** Record a version's files — one multi-row INSERT per chunk. */
export async function insertVersionFiles(
  tx: Handle,
  versionId: string,
  entries: readonly VersionFileEntry[],
): Promise<void> {
  for (let i = 0; i < entries.length; i += INSERT_CHUNK_ROWS) {
    await tx
      .insert(siteVersionFiles)
      .values(entries.slice(i, i + INSERT_CHUNK_ROWS).map((entry) => ({ versionId, ...entry })));
  }
}

/**
 * Each named version's paths, in path order. Every id asked for is in the map;
 * a version with no rows maps to an empty list.
 */
export async function versionPaths(
  tx: Handle,
  versionIds: readonly string[],
): Promise<Map<string, string[]>> {
  const paths = new Map<string, string[]>(versionIds.map((id) => [id, []]));
  if (versionIds.length === 0) return paths;
  const rows = await tx
    .select({ versionId: siteVersionFiles.versionId, path: siteVersionFiles.path })
    .from(siteVersionFiles)
    .where(inArray(siteVersionFiles.versionId, [...versionIds]))
    .orderBy(asc(siteVersionFiles.path));
  for (const row of rows) paths.get(row.versionId)?.push(row.path);
  return paths;
}

/** A version's files, in path order. */
export async function versionFiles(tx: Handle, versionId: string): Promise<VersionFileEntry[]> {
  return tx
    .select({
      path: siteVersionFiles.path,
      sizeBytes: siteVersionFiles.sizeBytes,
      sha256: siteVersionFiles.sha256,
    })
    .from(siteVersionFiles)
    .where(eq(siteVersionFiles.versionId, versionId))
    .orderBy(asc(siteVersionFiles.path));
}

/** Every R2 key of every version of a site — current and previous alike. */
export async function siteObjectKeys(tx: Handle, siteId: string): Promise<string[]> {
  const rows = await tx
    .select({ versionId: siteVersionFiles.versionId, path: siteVersionFiles.path })
    .from(siteVersionFiles)
    .innerJoin(siteVersions, eq(siteVersions.id, siteVersionFiles.versionId))
    .where(eq(siteVersions.siteId, siteId));
  return rows.map((row) => siteObjectKey(siteId, row.versionId, row.path));
}

/**
 * Every R2 key of the named versions of a site. Scoped by `site_id`: a version
 * id that belongs to another site names nothing.
 */
export async function versionFileKeys(
  tx: Handle,
  siteId: string,
  versionIds: readonly string[],
): Promise<string[]> {
  if (versionIds.length === 0) return [];
  const rows = await tx
    .select({ versionId: siteVersionFiles.versionId, path: siteVersionFiles.path })
    .from(siteVersionFiles)
    .innerJoin(siteVersions, eq(siteVersions.id, siteVersionFiles.versionId))
    .where(and(eq(siteVersions.siteId, siteId), inArray(siteVersionFiles.versionId, [...versionIds])));
  return rows.map((row) => siteObjectKey(siteId, row.versionId, row.path));
}
