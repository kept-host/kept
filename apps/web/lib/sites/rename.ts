/**
 * Rename an owned page — the ONE management verb in E06 that touches the edge.
 *
 * ── THE ORDER, AND WHY IT IS THIS ONE (epic decision D2) ─────────────────────
 *
 *   UPDATE sites SET slug = new        ← inside a transaction, NOT yet committed
 *   writeManifest(new)                 ← pointer → KV → purge
 *   COMMIT                             ← the slug is now the account's for good
 *   removeManifest(old)                ← pointer → KV → purge
 *
 * **New first, old second, never the reverse.** New-first's transient state is
 * "both slugs resolve", which is harmless and self-healing. Old-first's
 * transient state is "neither resolves", which is an outage on a page somebody
 * may have linked to.
 *
 * **The UPDATE is first inside the transaction, and that is not a contradiction
 * of the above.** It is what makes the manifest write safe. `sites_slug_key` is
 * the only authority on whether a name is free, and the statement that consults
 * it is the UPDATE — so running it first is how this path learns the new slug is
 * unclaimed BEFORE `writeManifest` puts a manifest there. Writing the manifest
 * first and discovering the collision afterwards would be a page takeover:
 * `writeManifest` overwrites whatever manifest already sits at that key, so the
 * stranger who owns `foo` would briefly serve this account's page, and the
 * unwind (`removeManifest("foo")`) would then take THEIR page dark permanently.
 * The uncommitted UPDATE reserves the name in the index without publishing it.
 *
 * The commit therefore lands BETWEEN the two manifest calls, and after
 * `writeManifest(new)` has succeeded — never before it. Every refusal above the
 * commit rolls the transaction back, so a refused rename writes no row, no
 * pointer, no KV key and issues no purge.
 *
 * ⚠️ A RENAME IS FOUR PURGES, TWO OF THEM DELAYED 125 s. `writeManifest` and
 * `removeManifest` each issue one immediately and schedule a second at
 * `2 × MANIFEST_KV_CACHE_TTL_SECONDS + 5 s` (see `lib/storage/manifest.ts` on
 * why one is not enough). That is the cost of the operation; do not optimise it
 * away.
 *
 * ⚠️ R2 IS UNTOUCHED. The layout is `sites/{siteId}/{versionId}/index.html`,
 * keyed by `siteId` — never by slug — so a rename moves no object and this
 * module contains no `r2Store()` call. That is the property `kv-manifest.ts`
 * called out in E00 and it is why this operation is cheap.
 *
 * ⚠️ THE OLD URL DOES NOT STOP INSTANTLY, and no code here can make it. The
 * Worker reads KV with `cacheTtl: MANIFEST_KV_CACHE_TTL_SECONDS` (60 — already
 * Cloudflare's floor) and `purge_cache` does not reach that layer. The window is
 * a fact of the architecture; the copy accommodates it — see `renameNotice` in
 * `./owner-client.ts`, which is written against a measurement rather than
 * against this arithmetic.
 *
 * ⚠️ A CRASH BETWEEN COMMIT AND `removeManifest(old)` LEAVES A GARBAGE POINTER
 * AND KV KEY for the old slug, pointing at a page that is now served under a
 * different name. Both resolve to the same `siteId`, so the reader sees the same
 * page — a stale alias, not an outage, and not a resurrection: nothing recreates
 * the row. The same is true of a `removeManifest` that fails and is logged.
 * **There is no compensating sweep here on purpose** — E07 owns the divergence
 * audit and the brooms (contract §7.5), and a bespoke sweeper in the request
 * path would be a second reconciler to keep correct.
 */
import type { RenameResult, SiteStatus } from "@kept/shared";
import { and, eq } from "drizzle-orm";

import { db } from "../db";
import { isSlugCollision } from "../db/queries/publish";
import { sites } from "../db/schema";
import { liveUrl } from "../publish/pipeline";
import { removeManifest, writeManifest } from "../storage/manifest";
import { SiteNotFoundError } from "./keep";
import { StudioRefusal } from "./studio-refusal";

/**
 * The chosen slug belongs to another page. Reported to the caller as "taken",
 * never as a 500 — including when the collision appears *between* whatever the
 * UI last checked and this write, which is the whole reason the check is done
 * by the index instead of by a query.
 *
 * NOT `SlugUnavailableError`: that one means "minting exhausted its attempts",
 * which is a broken CSPRNG or a broken index and maps to a 503. This one means
 * "somebody already has that name", which is a normal answer to a normal
 * request.
 */
export class SlugTakenError extends StudioRefusal {
  constructor(public readonly slug: string) {
    super("name_taken", `"${slug}" is already taken. Try another name.`);
    this.name = "SlugTakenError";
  }
}

/**
 * The page is not in a state that may be renamed.
 *
 * E06 *renders* `quarantined` and `under_review` and writes neither, so a page
 * in either state is read-only here: moving a flagged page to a fresh URL is
 * precisely the evasion the flag exists to stop. `archived` and `expired` are
 * refused for a plainer reason — they are not being served, so there is no
 * manifest to move and a rename would silently rewrite a row nobody can see.
 */
export class SiteNotRenamableError extends StudioRefusal {
  constructor(public readonly status: SiteStatus) {
    super("not_allowed_in_status", explainStatus(status));
    this.name = "SiteNotRenamableError";
  }
}

function explainStatus(status: SiteStatus): string {
  switch (status) {
    case "quarantined":
    case "under_review":
      return "This page is under review, so its address is locked while that is resolved. Everything else about it still works.";
    case "archived":
      return "This page has been deleted, so there is no address to change.";
    case "expired":
      return "This page has expired and is not being served. Keep it again first, then rename it.";
    default:
      return "This page cannot be renamed right now.";
  }
}

/**
 * The store write left something behind, or nothing at all — either way, refuse.
 * Nothing was applied (the transaction rolled back), so the person reads
 * "retry", never "we half-moved your page"; the failed step is the log's.
 */
export class RenameStoreError extends StudioRefusal {
  constructor(detail: string) {
    super(
      "internal_error",
      "kept could not move this page to the new address just now. Nothing changed — the page is still live at its current one. Try again in a moment.",
      `The rename could not be published to the edge: ${detail}`,
    );
    this.name = "RenameStoreError";
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Move a page to a new slug.
 *
 * The caller has already validated the *shape* of `nextSlug`
 * (`checkChosenSlug`); this function owns availability, state and ordering.
 *
 * @throws {SiteNotFoundError} the page does not exist or is not this profile's
 * @throws {SlugTakenError} another page holds that slug
 * @throws {SiteNotRenamableError} the page is not `live`
 * @throws {RenameStoreError} the new manifest could not be written
 */
export async function renameSite(
  siteId: string,
  profileId: string,
  nextSlug: string,
): Promise<RenameResult> {
  const { result, previousSlug } = await db.transaction(async (tx) => {
    // Owner scope in the SQL, never applied afterwards in JS — the same rule
    // `getOwnedSiteBySlug` states. `FOR UPDATE` holds the row for the whole
    // read-modify-write, so two renames of one page serialise instead of
    // racing to write two manifests.
    const [site] = await tx
      .select({
        id: sites.id,
        slug: sites.slug,
        status: sites.status,
        region: sites.region,
        currentVersionId: sites.currentVersionId,
      })
      .from(sites)
      .where(and(eq(sites.id, siteId), eq(sites.ownerId, profileId)))
      .for("update");

    if (!site) throw new SiteNotFoundError(siteId);

    // Renaming a page to the name it already has. A no-op success — not a
    // collision (it would collide with itself), and not four purges for a
    // change that did not happen.
    if (site.slug === nextSlug) {
      return {
        result: {
          siteId: site.id,
          slug: site.slug,
          previousSlug: site.slug,
          liveUrl: liveUrl(site.slug),
        },
        previousSlug: null,
      };
    }

    if (site.status !== "live") throw new SiteNotRenamableError(site.status);

    if (!site.currentVersionId) {
      // A `live` row with no version cannot be expressed as a manifest at all
      // (`kvManifestSchema.versionId` is required). Unexpected rather than a
      // user error: every successful publish sets it.
      throw new Error(
        `Site ${site.id} is live with no current version; its manifest cannot be rewritten.`,
      );
    }

    // THE ONLY AUTHORITY ON AVAILABILITY. Not a pre-flight read — this is the
    // statement that consults `sites_slug_key`, and a 23505 off it is the
    // answer "taken". Uncommitted, so the name is reserved but not yet public.
    try {
      await tx
        .update(sites)
        .set({ slug: nextSlug, updatedAt: new Date() })
        .where(eq(sites.id, siteId));
    } catch (err) {
      if (isSlugCollision(err)) throw new SlugTakenError(nextSlug);
      throw err;
    }

    const written = await writeManifest(nextSlug, {
      siteId: site.id,
      versionId: site.currentVersionId,
      // `live` by the guard above. The clock lives in Postgres, never here, so
      // a draft and a kept page write the identical manifest.
      status: "live",
      region: site.region,
      ownerId: profileId,
      updatedAt: Date.now(),
    });

    if (!written.ok) {
      // `step: "kv"` means the POINTER is written and must come back out;
      // `"validate"` and `"pointer"` mean nothing reached a store. Safe to
      // remove because the new slug is reserved by this uncommitted UPDATE, so
      // no other page can own the manifest we are deleting.
      if (written.step === "kv") {
        const unwound = await removeManifest(nextSlug);
        if (!unwound.ok) {
          console.error(
            `[kept] rename: ROLLBACK INCOMPLETE — slug "${nextSlug}" kept a pointer after a failed manifest write (${unwound.step}: ${unwound.error}). The row is rolled back, so a pointer may resolve a slug no row claims. E07 DIVERGENCE AUDIT: reconcile against Postgres (contract §7.5).`,
          );
        }
      }
      // Throwing rolls the transaction back: the slug column is unchanged and
      // the old manifest is still the only one serving this page.
      throw new RenameStoreError(`${written.step}: ${written.error}`);
    }

    return {
      result: {
        siteId: site.id,
        slug: nextSlug,
        previousSlug: site.slug,
        liveUrl: liveUrl(nextSlug),
      },
      previousSlug: site.slug,
    };
  });

  // COMMITTED. The new slug serves, and from here nothing can fail in a way
  // that costs the user their rename — only in a way that leaves the old slug
  // resolving to the same page for longer than intended.
  if (previousSlug !== null) {
    try {
      const removed = await removeManifest(previousSlug);
      if (!removed.ok) {
        console.error(
          `[kept] rename: site ${result.siteId} moved to "${result.slug}" but the old slug "${previousSlug}" failed to unpublish at the "${removed.step}" step — ${removed.error}. Both slugs now resolve to the same page; the rename itself succeeded. Replay this removal (contract §3).`,
        );
      }
    } catch (err) {
      console.error(
        `[kept] rename: site ${result.siteId} moved to "${result.slug}" but removing the old slug "${previousSlug}" threw — ${message(err)}. Both slugs now resolve to the same page; the rename itself succeeded.`,
      );
    }
  }

  return result;
}
