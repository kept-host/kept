/**
 * Real pages for the scan runtime drills (`lib/scan/run.test.ts`,
 * `lib/admin/cli.test.ts`) — E07 task 007 — and, through `insertPage`, for the
 * screen specs' `seedKept` (`e2e/owner-fixtures.ts`). Test-only: nothing in the
 * app imports it, and its name keeps it outside the unit-test glob.
 *
 * NO MOCKS. A page is a real anonymous `sites` row, a real `site_versions` row
 * and the real R2 object its `r2_key` names, so a scan reads, extracts and
 * decides exactly as it does for a published page. No manifest is written
 * here: only a committed `setStatus` (a flag) writes one, and `cleanup()`
 * removes exactly those still served — dev KV is on the free plan (1k deletes
 * a day).
 */
import { hashContent } from "@kept/shared";
import { inArray } from "drizzle-orm";

import { db } from "../db";
import type { ScanTarget } from "../db/queries/scans";
import { moderationActions, sites, siteVersions } from "../db/schema";
import { PAGE_CONTENT_TYPE, pageObjectKey, r2Store } from "../storage/r2";

import { stillServed } from "./moderation-drill";
import { clearPendingPurges } from "./pending-purges";
import { removeServedManifests } from "./served-manifests";

/** The `sites` columns `insertPage` takes from its caller; it derives the rest from the bytes. */
export type PageRow = Omit<typeof sites.$inferInsert, "currentVersionId" | "contentHash" | "sizeBytes"> & { id: string };

/**
 * A real page serving `html`: the R2 object, the `sites` row and its current
 * `site_versions` row (active since `activatedAt`) — everything a publish
 * writes except the manifest, so nothing serves at its slug.
 */
export async function insertPage(html: string, row: PageRow, activatedAt: Date = new Date()): Promise<ScanTarget> {
  const versionId = crypto.randomUUID();
  const r2Key = pageObjectKey(row.id, versionId);
  const contentHash = await hashContent(html);
  const sizeBytes = Buffer.byteLength(html, "utf8");

  await r2Store().put(r2Key, html, PAGE_CONTENT_TYPE);
  await db.insert(sites).values({ ...row, currentVersionId: versionId, contentHash, sizeBytes });
  await db.insert(siteVersions).values({ id: versionId, siteId: row.id, r2Key, contentHash, sizeBytes, activatedAt });
  return { siteId: row.id, versionId, slug: row.slug, contentHash, r2Key };
}

export class ScanDrill {
  private readonly siteIds = new Set<string>();
  private readonly slugs = new Set<string>();
  private readonly r2Keys = new Set<string>();
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
  async page(html: string, activatedAt: Date = new Date()): Promise<ScanTarget> {
    const siteId = crypto.randomUUID();
    const slug = `${this.prefix}-${siteId.slice(0, 8)}`;
    this.siteIds.add(siteId);
    this.slugs.add(slug);
    const page = await insertPage(
      html,
      { id: siteId, slug, status: "live", ownerId: null, publisherHash: `${this.prefix}-drill` },
      activatedAt,
    );
    this.r2Keys.add(page.r2Key);
    return page;
  }

  async cleanup(): Promise<void> {
    const siteIds = [...this.siteIds];
    if (siteIds.length > 0) {
      // Only a published page, or one a committed flag synced, has a manifest to remove.
      await removeServedManifests([...this.published, ...(await stillServed(siteIds))]);
      await db.delete(moderationActions).where(inArray(moderationActions.siteId, siteIds));
      await clearPendingPurges(this.slugs, siteIds);
      const versions = await db
        .select({ r2Key: siteVersions.r2Key })
        .from(siteVersions)
        .where(inArray(siteVersions.siteId, siteIds));
      for (const { r2Key } of versions) this.r2Keys.add(r2Key);
      // `scans` and `site_versions` cascade with the site.
      await db.delete(sites).where(inArray(sites.id, siteIds));
    }
    for (const key of this.r2Keys) await r2Store().delete(key).catch(() => undefined);
  }
}
