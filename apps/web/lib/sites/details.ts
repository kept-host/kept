/**
 * A page's Details — its title and its Explore flag (PRD §5.2, D11, D12).
 * E06 task 012; the route is `PATCH /api/sites/:id`.
 *
 * ── WHO MAY CHANGE WHAT (PRD §5.2's matrix, the server half) ─────────────────
 *
 *   · **title** — on a `live` page (kept or draft) and on one `under_review`.
 *     A `quarantined`, `expired` or `archived` page is not being served, and its
 *     owner's verbs there are download and delete.
 *   · **listedPublic** — on a KEPT `live` page only (D12). It is preserved
 *     through demote and re-keep (`demoteSite` never writes it), so a draft
 *     still carries its owner's choice; it just cannot change it.
 *
 * ── THE TITLE HAS TWO WRITERS, AND THE ROW SAYS WHICH ────────────────────────
 * Saving a title makes it the owner's (`title_source = 'owner'`), and no replace
 * or restore overwrites it — `pointSiteAt` decides that in SQL. Saving `""`
 * hands it back: `title_source = 'html'` and the title re-derived from the
 * CURRENT version's bytes, read from R2 (the authority on them).
 *
 * ⚠️ UNDER THE SITE-ROW LOCK. The revert reads `current_version_id` and its
 * bytes with the row locked `FOR UPDATE`, the lock restore and prune take, so a
 * replace that lands meanwhile waits for this write and then re-titles from its
 * own bytes — never the other way round, which would stamp the previous
 * version's title onto new bytes.
 *
 * Every write moves `updated_at` (`$onUpdate`), and that is the point of Bug 4:
 * it is the OG card's `?v=` key, so a renamed card can never be served from a
 * year-long cache under the old title. Nothing here touches KV — neither field
 * changes what visitors are served in E06 (PRD §15: "Saved.").
 */
import type { SiteStatus, SiteUpdateRequest, StudioSite } from "@kept/shared";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { lockSiteForOwner } from "../db/queries/publish";
import { sites } from "../db/schema";
import { extractPageTitle } from "../publish/page-title";
import { pageObjectKey, r2Store } from "../storage/r2";

import { isManagementRestricted } from "./display";
import { SiteNotFoundError } from "./keep";
import { StudioRefusal } from "./studio-refusal";
import { readStudioSite } from "./studio-site";

/** Where an owner may edit the title (PRD §5.2). */
const TITLE_EDITABLE: readonly SiteStatus[] = ["live", "under_review"];

const NOT_SERVED =
  "This page isn't being served, so its details can't be changed. You can still download or delete it.";

const DRAFT_NOT_LISTABLE =
  "Keep this page first. Only kept pages can be listed on Explore.";

const FLAGGED_NOT_LISTABLE =
  "Listing is paused while this page is under review.";

const TITLE_READ_FAILED =
  "kept couldn't read this page's file to find its own title. Nothing changed — try again.";

/**
 * The page's own `<title>`, read from the bytes it serves now. `null` when the
 * row has no version, the object is missing or the document has no title —
 * all of which render as the page's name.
 */
async function htmlTitleOf(site: { id: string; currentVersionId: string | null }): Promise<string | null> {
  if (!site.currentVersionId) return null;
  let html: string | null;
  try {
    html = await r2Store().get(pageObjectKey(site.id, site.currentVersionId));
  } catch (err) {
    throw new StudioRefusal(
      "internal_error",
      TITLE_READ_FAILED,
      `R2 read of site ${site.id} version ${site.currentVersionId} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return html === null ? null : extractPageTitle(html);
}

/**
 * Save an owned page's title and/or Explore flag. `update` is already parsed by
 * `siteUpdateRequestSchema` (title collapsed, trimmed, within the cap).
 *
 * @throws {SiteNotFoundError} not this owner's, or `removed`
 * @throws {StudioRefusal} `not_allowed_in_status` — see the header's matrix
 * @throws {StudioRefusal} `internal_error` — the bytes for a title revert could not be read
 */
export async function updateSiteDetails(
  siteId: string,
  profileId: string,
  update: SiteUpdateRequest,
): Promise<StudioSite> {
  return db.transaction(async (tx) => {
    const site = await lockSiteForOwner(tx, siteId, profileId);
    // `removed` is E07's takedown: to its owner the page no longer exists.
    if (!site || site.status === "removed") throw new SiteNotFoundError(siteId);

    const set: Partial<typeof sites.$inferInsert> = {};

    if (update.title !== undefined) {
      if (!TITLE_EDITABLE.includes(site.status)) {
        throw new StudioRefusal("not_allowed_in_status", NOT_SERVED);
      }
      if (update.title === "") {
        set.title = await htmlTitleOf(site);
        set.titleSource = "html";
      } else {
        set.title = update.title;
        set.titleSource = "owner";
      }
    }

    if (update.listedPublic !== undefined) {
      const refusal =
        site.expiresAt !== null
          ? DRAFT_NOT_LISTABLE
          : site.status === "live"
            ? null
            : isManagementRestricted(site.status)
              ? FLAGGED_NOT_LISTABLE
              : NOT_SERVED;
      if (refusal) throw new StudioRefusal("not_allowed_in_status", refusal);
      set.listedPublic = update.listedPublic;
    }

    await tx.update(sites).set(set).where(eq(sites.id, site.id));
    return readStudioSite(tx, site.id);
  });
}
