/**
 * Restore — point an owned page back at one of its previous versions (D7, PRD
 * §5.5). E06 task 007. Also what the studio's Undo toast calls (AC25): Undo is a
 * restore of the version that was current before the replace.
 *
 *   PG tx (lock site; current = v; v.activated_at = now())
 *     → writeManifest(slug, v)   — a REPLACE EVENT in edge-purge-contract terms
 *     → enqueueScan(site, v)
 *
 * ── NO PAGE BYTES ARE WRITTEN, AND THIS FILE IS WHERE THAT IS PROVEN (AC28) ──
 * The restored version's object has sat in R2 since the replace that stored it,
 * keyed by `siteId` + `versionId`, so moving the pointer is the whole job. This
 * module is kept apart from `./manage.ts` (which deletes pruned objects) so
 * `versions.test.ts` can assert, over this file's source, that it never puts,
 * deletes or re-publishes an object: its one R2 call is a read. The slug pointer
 * `writeManifest` rewrites is the MANIFEST (contract §7), rewritten on every
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
import type { KvManifest, RestoreResult } from "@kept/shared";

import { db } from "../db";
import { lockSiteForOwner, pointSiteAt, type SitePointer } from "../db/queries/publish";
import { findSiteVersion, stampActivated } from "../db/queries/versions";
import { enqueueScan } from "../publish/hooks";
import { extractPageTitle } from "../publish/page-title";
import { liveUrl } from "../publish/pipeline";
import { writeManifest } from "../storage/manifest";
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
  const manifestFor = (servedVersionId: string): KvManifest => ({
    siteId: site.id,
    versionId: servedVersionId,
    // Only a `live` page is restored, and the clock lives in Postgres.
    status: "live",
    region: site.region,
    ownerId: profileId,
    updatedAt: Date.now(),
  });

  const written = await writeManifest(site.slug, manifestFor(version.id));
  if (!written.ok) {
    console.error(
      `[kept] restore: manifest write failed at the "${written.step}" step for site ${site.id} (slug "${site.slug}", version ${version.id}) — ${written.error}`,
    );
    // `kv` means the pointer already names the restored version, so it is put
    // back; at `validate` or `pointer` nothing reached a store.
    if (written.step === "kv" && previous.versionId) {
      const rewound = await writeManifest(site.slug, manifestFor(previous.versionId));
      if (!rewound.ok) {
        console.error(
          `[kept] ROLLBACK INCOMPLETE — slug "${site.slug}" pointer may still name version ${version.id}: "${rewound.step}" — ${rewound.error}. E07 DIVERGENCE AUDIT: reconcile against Postgres (contract §7.5).`,
        );
      }
    }
    try {
      await db.transaction(async (tx) => {
        await pointSiteAt(tx, site.id, previous);
        await stampActivated(tx, site.id, version.id, version.activatedAt);
      });
    } catch (err) {
      console.error(
        `[kept] ROLLBACK INCOMPLETE — site ${site.id} (slug "${site.slug}") still points at version ${version.id}: ${message(err)}. E07 DIVERGENCE AUDIT: Postgres is the authority (contract §7.5).`,
      );
    }
    throw new ManageStoreError("restore", `${written.step}: ${written.error}`);
  }

  // The bytes are not new, but the served version is: the scan contract is
  // keyed by (site, version) and a restore is a replace event.
  void enqueueScan(site.id, version.id);

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
