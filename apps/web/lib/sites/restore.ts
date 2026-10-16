/**
 * Restore — point an owned page back at one of its previous versions (D7, PRD
 * §5.5). E06 task 007. Also what the studio's Undo toast calls (AC25): Undo is a
 * restore of the version that was current before the replace.
 *
 *   PG tx (lock site; current = v; v.activated_at = now())
 *     → syncManifest(site)      — a REPLACE EVENT in edge-purge-contract terms,
 *                                 written from the row under its lock (D18)
 *     → setStatus(under_review) — only when v's last scan flagged (E07 edge case 4)
 *     → enqueueScan(site, v, "restore")
 *
 * ── NO PAGE BYTES ARE WRITTEN, AND THIS FILE IS WHERE THAT IS PROVEN (AC28) ──
 * The restored version's object has sat in R2 since the replace that stored it,
 * keyed by `siteId` + `versionId`, so moving the pointer is the whole job. This
 * module is kept apart from `./manage.ts` (which deletes pruned objects) so
 * `versions.test.ts` can assert, over this file's source, that it never puts,
 * deletes or re-publishes an object: its one R2 call is a read. The slug pointer
 * `syncManifest` rewrites is the MANIFEST (contract §7), rewritten on every
 * replace event, not page bytes. No pruning either — the count is unchanged.
 *
 * ── WHY IT READS THE BYTES ANYWAY: ONE READ, TWO REASONS ──────────────────────
 *   1. The title. The PRD does not say what a restore does to it; the default
 *      chosen (task 007, recorded for the PR) is the replace rule run backwards —
 *      the restored bytes' `<title>`, unless the owner set one (`pointSiteAt`
 *      keeps an owner title in SQL). Otherwise the card would show the name of
 *      the page that was just replaced away.
 *   2. Existence. A prune deletes the object before its row, so a row whose
 *      bytes are gone can exist for as long as a failed prune leaves it. Such a
 *      version must never become current — it is `version_not_found`.
 *
 * The read happens under the site-row lock a prune takes too, so a concurrent
 * prune either finished first (the row is gone: not found) or waits for this.
 */
import type { RestoreResult } from "@kept/shared";

import { db } from "../db";
import { lastVerdictFor, setStatus } from "../moderation/status";
import { lockSiteForOwner, pointSiteAt, type SitePointer } from "../db/queries/publish";
import { findSiteVersion, stampActivated } from "../db/queries/versions";
import { enqueueScan } from "../publish/hooks";
import { extractPageTitle } from "../publish/page-title";
import { liveUrl } from "../publish/pipeline";
import { syncManifest } from "../storage/manifest";
import { r2Store } from "../storage/r2";

import { SiteNotFoundError } from "./keep";
import { ManageStoreError, SiteNotReplaceableError } from "./manage";
import { StudioRefusal } from "./studio-refusal";

/**
 * The one sentence for a version that is not this page's — one that never
 * existed, belongs to another page, or was pruned. Never says which: a version
 * id from somebody else's page must read exactly like a made-up one.
 */
export const VERSION_NOT_FOUND_MESSAGE =
  "That version isn't available for this page any more. Pick another from the list.";

export class VersionNotFoundError extends StudioRefusal {
  constructor(detail?: string) {
    super("version_not_found", VERSION_NOT_FOUND_MESSAGE, detail);
    this.name = "VersionNotFoundError";
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Make `versionId` the served version of `siteId` again.
 *
 * `{ unchanged: true }` when it already is. Otherwise the answer names the
 * version that was current — so "undo the undo" is one more restore.
 *
 * @throws {SiteNotFoundError} the page does not exist, is not this profile's, or is `removed`
 * @throws {SiteNotReplaceableError} the page is not `live` (the same gate as replace)
 * @throws {VersionNotFoundError} the version is not this page's, or its bytes are gone
 * @throws {ManageStoreError} the manifest could not be moved; everything was put back
 */
export async function restoreVersion(
  siteId: string,
  versionId: string,
  profileId: string,
): Promise<RestoreResult> {
  const moved = await db.transaction(async (tx) => {
    const site = await lockSiteForOwner(tx, siteId, profileId);
    if (!site || site.status === "removed") throw new SiteNotFoundError(siteId);
    if (site.status !== "live") throw new SiteNotReplaceableError(site.status);

    // Scoped by `site_id`: another page's version is not found, never restored.
    const version = await findSiteVersion(tx, site.id, versionId);
    if (!version) throw new VersionNotFoundError();
    if (version.id === site.currentVersionId) return null;

    const html = await r2Store().get(version.r2Key);
    if (html === null) {
      throw new VersionNotFoundError(
        `version ${version.id} of site ${site.id} has a row but no object at "${version.r2Key}" — a prune deleted the bytes and not the row; the next prune collects it.`,
      );
    }

    await stampActivated(tx, site.id, version.id, "now");
    const { title } = await pointSiteAt(tx, site.id, {
      versionId: version.id,
      title: extractPageTitle(html),
      contentHash: version.contentHash,
      sizeBytes: version.sizeBytes,
    });
    return { site, version, title };
  });

  if (!moved) return { unchanged: true };
  const { site, version, title } = moved;

  const previous: SitePointer = {
    versionId: site.currentVersionId,
    title: site.title,
    contentHash: site.contentHash,
    sizeBytes: site.sizeBytes,
  };

  // D18: the manifest is the row's, read under its lock AFTER this commit — so a
  // flag that committed since the status check above is what the edge serves.
  const synced = await syncManifest(site.id);
  if (!synced.ok) {
    console.error(
      `[kept] restore: manifest sync failed for site ${site.id} (slug "${site.slug}", version ${version.id}) — ${synced.error}`,
    );
    // Revert the row, then sync again: the edge names the version it named before.
    try {
      await db.transaction(async (tx) => {
        await pointSiteAt(tx, site.id, previous);
        await stampActivated(tx, site.id, version.id, version.activatedAt);
      });
    } catch (err) {
      console.error(
        `[kept] ROLLBACK INCOMPLETE — site ${site.id} (slug "${site.slug}") still points at version ${version.id}: ${message(err)}. Postgres is the authority (contract §7.5).`,
      );
    }
    // A second failure leaves its `pending_purges` row; the repurge job converges
    // the edge on whichever version the row names.
    await syncManifest(site.id);
    throw new ManageStoreError("restore", synced.error);
  }

  // Edge case 4: a version whose last scan flagged goes straight back to
  // `under_review` — the scanner's own edge, with the verdict it already gave —
  // unless an admin restored that version (D-72), which `setStatus` refuses.
  const last = await lastVerdictFor(version.id);
  if (last?.verdict === "flag") {
    await setStatus(site.id, "under_review", {
      actor: "scanner",
      versionId: version.id,
      reason: last.reason ?? "other",
      automated: true,
      scanId: last.scanId,
    });
  }

  // The bytes are not new, but the served version is: the scan contract is
  // keyed by (site, version) and a restore is a replace event.
  void enqueueScan(site.id, version.id, "restore");

  return {
    unchanged: false,
    siteId: site.id,
    slug: site.slug,
    liveUrl: liveUrl(site.slug),
    versionId: version.id,
    previousVersionId: previous.versionId,
    title,
    expiresAt: site.expiresAt ? site.expiresAt.toISOString() : null,
  };
}
