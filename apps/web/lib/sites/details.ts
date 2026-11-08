/**
 * A page's Details — its title, its Explore flag (PRD §5.2, D11, D12; E06 task
 * 012) and its provenance (E10 §4.1, D8): model, tool, prompt, README, source
 * link, "Show the prompt", "Show 'Made with'" and "Allow remix". The route is
 * `PATCH /api/sites/:id`.
 *
 * ── WHO MAY CHANGE WHAT (PRD §5.2's matrix, the server half) ─────────────────
 *
 *   · **title and every provenance field** — on a `live` page (kept or draft)
 *     and on one `under_review`. A `quarantined`, `expired` or `archived` page
 *     is not being served, and its owner's verbs there are download and delete.
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
 * ── PROVENANCE HAS TWO WRITERS TOO, AND THE LAST ONE WINS (Q9) ──────────────
 * The publish pipelines (E09) write the fields an agent sends; this is the
 * second writer. Values go through E09's own `cleanProvenance` — no second
 * sanitiser — and `""` (the schema's `null`) clears a field. There are no
 * `*_source` columns: an agent's next replace may overwrite an owner's edit,
 * and the Details panel says so.
 *
 * ⚠️ UNDER THE SITE-ROW LOCK. The revert reads `current_version_id` and its
 * bytes with the row locked `FOR UPDATE`, the lock restore and prune take, so a
 * replace that lands meanwhile waits for this write and then re-titles from its
 * own bytes — never the other way round, which would stamp the previous
 * version's title onto new bytes.
 *
 * Every write moves `updated_at` (`$onUpdate`), and that is the point of Bug 4:
 * it is the OG card's `?v=` key, so a renamed card can never be served from a
 * year-long cache under the old title.
 *
 * ── WHAT A SAVE OWES THE EDGE (D5, Q5) ──────────────────────────────────────
 * Only a KEPT page's badge and README page show these values (a draft's badge
 * is fixed, D4). After the commit, when a value the badge shows changed (model,
 * "Made with", "Allow remix", the README) — or, while the page has a README, a
 * value the README page shows (title, tool, source link, prompt, "Show the
 * prompt") — the README page is refreshed and `syncManifest` rewrites the
 * manifest and purges the page and `/_kept/readme`. Any other save writes no
 * KV: a title-only save on a page without a README is the row alone.
 */
import type { SiteStatus, SiteUpdate, StudioSite } from "@kept/shared";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { lockSiteForOwner } from "../db/queries/publish";
import { sites } from "../db/schema";
import { extractPageTitle } from "../publish/page-title";
import { cleanProvenance } from "../publish/provenance";
import { refreshReadmePage } from "../readme/page";
import { syncManifest } from "../storage/manifest";
import { pageObjectKey, r2Store } from "../storage/r2";

import { isManagementRestricted } from "./display";
import { SiteNotFoundError } from "./keep";
import { StudioRefusal } from "./studio-refusal";
import { readStudioSite } from "./studio-site";

/** Where an owner may edit the title and the provenance (PRD §5.2). */
const EDITABLE: readonly SiteStatus[] = ["live", "under_review"];

/** The provenance text fields — cleared with `null`, otherwise through `cleanProvenance`. */
const PROVENANCE_TEXT = ["model", "tool", "prompt", "readme", "sourceUrl"] as const;

/** The owner's switches. */
const PROVENANCE_FLAGS = ["showPrompt", "showMadeWith", "allowRemix"] as const;

/** What a kept page's badge shows (`badgeDataFor`) — a change re-syncs the manifest. */
const BADGE_FIELDS = ["model", "showMadeWith", "allowRemix", "readme"] as const;

/** What the README page shows besides — a change re-syncs only while there is one. */
const README_FIELDS = ["title", "tool", "sourceUrl", "prompt", "showPrompt"] as const;

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

/** Q5: does this save change what a kept page's badge or README page shows? */
function showsChange(before: StudioSite, after: StudioSite): boolean {
  if (after.expiresAt !== null) return false;
  const changed = (field: keyof StudioSite) => before[field] !== after[field];
  if (BADGE_FIELDS.some(changed)) return true;
  return Boolean(before.readme ?? after.readme) && README_FIELDS.some(changed);
}

/**
 * Save an owned page's Details. `update` is already parsed by
 * `siteUpdateRequestSchema` (title collapsed, trimmed, within the cap; `""` on a
 * provenance field is `null`).
 *
 * @throws {SiteNotFoundError} not this owner's, or `removed`
 * @throws {StudioRefusal} `not_allowed_in_status` — see the header's matrix
 * @throws {StudioRefusal} `internal_error` — the bytes for a title revert could not be read
 */
export async function updateSiteDetails(
  siteId: string,
  profileId: string,
  update: SiteUpdate,
): Promise<StudioSite> {
  const { before, after } = await db.transaction(async (tx) => {
    const site = await lockSiteForOwner(tx, siteId, profileId);
    // `removed` is E07's takedown: to its owner the page no longer exists.
    if (!site || site.status === "removed") throw new SiteNotFoundError(siteId);

    const editsDetails =
      update.title !== undefined ||
      [...PROVENANCE_TEXT, ...PROVENANCE_FLAGS].some((field) => update[field] !== undefined);
    if (editsDetails && !EDITABLE.includes(site.status)) {
      throw new StudioRefusal("not_allowed_in_status", NOT_SERVED);
    }

    const set: Partial<typeof sites.$inferInsert> = {};

    if (update.title !== undefined) {
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

    // E09's validator, not a second one. A value it cleans away entirely (only
    // control characters, say) clears the field, as `""` does.
    const cleaned = cleanProvenance({
      model: update.model ?? undefined,
      tool: update.tool ?? undefined,
      prompt: update.prompt ?? undefined,
      readme: update.readme ?? undefined,
      source_url: update.sourceUrl ?? undefined,
    });
    for (const field of PROVENANCE_TEXT) {
      if (update[field] !== undefined) set[field] = cleaned[field] ?? null;
    }
    if (update.showPrompt !== undefined) set.showPrompt = update.showPrompt;
    if (update.showMadeWith !== undefined) set.showMadeWith = update.showMadeWith;
    if (update.allowRemix !== undefined) set.allowRemix = update.allowRemix;

    const before = await readStudioSite(tx, site.id);
    await tx.update(sites).set(set).where(eq(sites.id, site.id));
    return { before, after: await readStudioSite(tx, site.id) };
  });

  // After the commit (D18): the README page first, then the sync that purges it.
  if (showsChange(before, after)) {
    await refreshReadmePage(after.id);
    await syncManifest(after.id);
  }
  return after;
}
