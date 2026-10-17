/**
 * Real pages for the scan runtime drills (`lib/scan/run.test.ts`,
 * `lib/admin/cli.test.ts`) — E07 task 007. Test-only: nothing in the app
 * imports it, and its name keeps it outside the unit-test glob.
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
    const versionId = crypto.randomUUID();
    const slug = `${this.prefix}-${siteId.slice(0, 8)}`;
    const r2Key = pageObjectKey(siteId, versionId);
    const contentHash = await hashContent(html);
    const sizeBytes = Buffer.byteLength(html, "utf8");

    await r2Store().put(r2Key, html, PAGE_CONTENT_TYPE);
    this.r2Keys.add(r2Key);
    await db.insert(sites).values({
      id: siteId,
      slug,
      status: "live",
      currentVersionId: versionId,
      ownerId: null,
      publisherHash: `${this.prefix}-drill`,
      contentHash,
      sizeBytes,
    });
    this.siteIds.add(siteId);
    this.slugs.add(slug);
    await db.insert(siteVersions).values({ id: versionId, siteId, r2Key, contentHash, sizeBytes, activatedAt });
    return { siteId, versionId, slug, contentHash, r2Key };
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
