/**
 * Real pages for the scan runtime drills (`lib/scan/run.test.ts`,
 * `lib/admin/cli.test.ts`) — E07 task 007 — and, through `insertPage`, for the
 * screen specs' `seedKept` (`e2e/owner-fixtures.ts`). Test-only: nothing in the
 * app imports it, and its name keeps it outside the unit-test glob.
 *
 * NO MOCKS. A page is a real anonymous `sites` row, a real `site_versions` row,
 * its `site_version_files` rows and the real R2 objects they name, so a scan
 * reads, extracts and decides exactly as it does for a published page. No
 * manifest is written here: only a committed `setStatus` (a flag) writes one,
 * and `cleanup()` removes exactly those still served — dev KV is on the free
 * plan (1k deletes a day).
 */
import { hashContent, SITE_INDEX } from "@kept/shared";
import { inArray } from "drizzle-orm";

import { db } from "../db";
import type { ScanTarget } from "../db/queries/scans";
import { insertVersionFiles, siteObjectKeys } from "../db/queries/version-files";
import { moderationActions, sites, siteVersions } from "../db/schema";
import type { FileSet } from "../publish/fileset/types";
import { PAGE_CONTENT_TYPE, pageObjectKey, r2Store, siteObjectKey } from "../storage/r2";

import { stillServed } from "./moderation-drill";
import { clearPendingPurges } from "./pending-purges";
import { removeServedManifests } from "./served-manifests";

/** The `sites` columns `insertPage` takes from its caller; it derives the rest from the bytes. */
export type PageRow = Omit<typeof sites.$inferInsert, "currentVersionId" | "contentHash" | "sizeBytes"> & { id: string };

/** What `insertSet` stores of a set — a `FileSet` read by the real reader, or one `index.html`. */
type StoredSet = Pick<FileSet, "entries" | "totalBytes" | "contentHash">;

/**
 * A real page serving `set`: every file's R2 object, the `sites` row, its
 * current `site_versions` row (active since `activatedAt`) and one
 * `site_version_files` row per file — everything a publish writes except the
 * manifest, so nothing serves at its slug.
 */
async function insertSet(set: StoredSet, row: PageRow, activatedAt: Date): Promise<ScanTarget> {
  const versionId = crypto.randomUUID();
  const { contentHash, totalBytes: sizeBytes } = set;
  for (const entry of set.entries) {
    await r2Store().put(siteObjectKey(row.id, versionId, entry.path), entry.bytes, entry.contentType);
  }
  await db.insert(sites).values({ ...row, currentVersionId: versionId, contentHash, sizeBytes });
  await db.insert(siteVersions).values({
    id: versionId,
    siteId: row.id,
    r2Key: pageObjectKey(row.id, versionId),
    contentHash,
    sizeBytes,
    activatedAt,
    fileCount: set.entries.length,
  });
  await insertVersionFiles(
    db,
    versionId,
    set.entries.map(({ path, bytes, sha256 }) => ({ path, sizeBytes: bytes.length, sha256 })),
  );
  return { siteId: row.id, versionId, slug: row.slug, contentHash };
}

/** A real single-file page serving `html` (`insertSet` of its one `index.html`). */
export async function insertPage(html: string, row: PageRow, activatedAt: Date = new Date()): Promise<ScanTarget> {
  const bytes = new TextEncoder().encode(html);
  const sha256 = await hashContent(html);
  return insertSet(
    {
      entries: [{ path: SITE_INDEX, bytes, sha256, contentType: PAGE_CONTENT_TYPE }],
      totalBytes: bytes.length,
      contentHash: sha256,
    },
    row,
    activatedAt,
  );
}

export class ScanDrill {
  private readonly siteIds = new Set<string>();
  private readonly slugs = new Set<string>();
  /** Pages a real publish path created: their manifest exists whatever happened since. */
  private readonly published = new Set<string>();

  constructor(private readonly prefix: string) {}

  /** Track a page a real publish path created, so `cleanup()` removes it and its manifest. */
  track(siteId: string, slug: string): void {
    this.siteIds.add(siteId);
    this.slugs.add(slug);
    this.published.add(slug);
  }

  /** A live anonymous kept page serving `html`, its version current since `activatedAt`. */
  page(html: string, activatedAt: Date = new Date()): Promise<ScanTarget> {
    return insertPage(html, this.row(), activatedAt);
  }

  /** A live anonymous kept page serving the file set `set` (`lib/testing/file-sets.ts`'s `fileSet`). */
  set(set: StoredSet): Promise<ScanTarget> {
    return insertSet(set, this.row(), new Date());
  }

  /** A new live anonymous page's row, tracked for `cleanup()`. */
  private row(): PageRow {
    const siteId = crypto.randomUUID();
    const slug = `${this.prefix}-${siteId.slice(0, 8)}`;
    this.siteIds.add(siteId);
    this.slugs.add(slug);
    return { id: siteId, slug, status: "live", ownerId: null, publisherHash: `${this.prefix}-drill` };
  }

  async cleanup(): Promise<void> {
    const siteIds = [...this.siteIds];
    if (siteIds.length > 0) {
      // Only a published page, or one a committed flag synced, has a manifest to remove.
      await removeServedManifests([...this.published, ...(await stillServed(siteIds))]);
      await db.delete(moderationActions).where(inArray(moderationActions.siteId, siteIds));
      await clearPendingPurges(this.slugs, siteIds);
      const keys = (await Promise.all(siteIds.map((siteId) => siteObjectKeys(db, siteId)))).flat();
      // `scans`, `site_versions` and `site_version_files` cascade with the site.
      await db.delete(sites).where(inArray(sites.id, siteIds));
      await r2Store().deleteMany(keys).catch(() => undefined);
    }
  }
}
