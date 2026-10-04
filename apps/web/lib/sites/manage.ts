/**
 * Replace and delete, for a signed-in owner — E06 task 006.
 *
 * ── TWO VERBS, TWO DELIBERATELY INVERSE ORDERINGS ────────────────────────────
 *
 *   replace:  Postgres (new version) → R2 object → pointer → KV → purge
 *   delete:   pointer → KV → purge   → Postgres (archive)
 *
 * **Publish ordering forwards, publish ordering backwards.** A replace's
 * dangerous half-state is "the manifest names bytes that do not exist", so the
 * bytes are written before the pointer moves. A delete's is "a row that says
 * gone while the page keeps serving", so the edge is unwound first and Postgres
 * second. Neither is negotiable, and neither is re-derived here: `replaceSite`
 * calls `writePageAndManifest` (which owns the forward sequence and its unwind)
 * and `deleteSite` calls `removeManifest` (which owns pointer-before-KV). A
 * `kv.put` in this file would be both a lint error and the resurrection bug.
 *
 * ── WHY THIS IS NOT `lib/publish/anon-manage.ts` WITH AN EXTRA ARGUMENT ───────
 * Both verbs have a bearer-token twin there whose store ordering is already
 * correct, and that ordering is reused above. What cannot be reused is the
 * AUTHORITY: the twins are keyed by a token in the path — whoever holds it may
 * act — and these are keyed by a site id plus a session cookie. Merging them
 * would put both credentials behind one handler, which is how one eventually
 * accepts the other's; the `/api/anon/` vs `/api/sites/` split (E05 D3) exists
 * for exactly that reason. The ownership check is a WHERE clause in
 * `findSiteForOwner`, so "not yours" and "does not exist" are the same `null`.
 *
 * ── THE TWO RULES THAT ARE EASIEST TO BREAK ──────────────────────────────────
 *
 * 1. **A replace does not touch the clock.** `insertReplacementVersion` writes
 *    neither `expires_at` nor `purge_after`, and nothing here writes them
 *    either. If re-dropping a file restarted the seven days, a weekly upload
 *    would hold a page forever for free and "keep it" would stop meaning
 *    anything. `REPLACE_CLOCK_NOTE` in `components/kept/draft-chip.tsx` is the
 *    sentence that promises this; this module is what makes it true.
 *
 * 2. **Deleting one page archives it.** `status → 'archived'`, the row stays,
 *    the R2 object stays, the version history stays. The slot frees for free,
 *    because `isKeptCondition` excludes `archived`. Deleting an *account* is
 *    the one path that ends in `removed` with a `purge_after` — that is task
 *    011, and the two terminal states are different on purpose.
 *
 * ⚠️ R2 IS KEYED BY `siteId`, NEVER BY SLUG. A replace writes a NEW `versionId`
 * under the SAME `siteId` and leaves every prior object where it is; a delete
 * removes no object at all. Version history is never deleted here — the
 * rollback UI that consumes it is E11's.
 */
import {
  hashContent,
  publishRequestSchema,
  type DeleteResult,
  type ReplaceResult,
  type SiteStatus,
} from "@kept/shared";

import {
  archiveSite,
  findSiteForOwner,
  insertReplacementVersion,
  revertReplacementVersion,
} from "../db/queries/publish";
import { enqueueScan } from "../publish/hooks";
import { extractPageTitle } from "../publish/page-title";
import { liveUrl, writePageAndManifest } from "../publish/pipeline";
import { removeManifest } from "../storage/manifest";
import { pageObjectKey } from "../storage/r2";

import { managementRefusal } from "./display";
import { keptQuotaFor, SiteNotFoundError } from "./keep";
import { StudioRefusal } from "./studio-refusal";

/**
 * The body of an owner write — a replace here, and the owned publish in
 * `./publish.ts` (task 004). One schema, because they carry the same thing: the
 * document, and nothing else.
 *
 * PICKED FROM THE PUBLISH SCHEMA rather than re-declared, so `MAX_PAGE_BYTES`,
 * the "looks like HTML" rule and every error code stay identical to the path
 * that first stored the page. What is deliberately left OUT:
 *
 *   · `turnstileToken` — the caller is authenticated by a session cookie and an
 *     origin check. A bot check on top of that protects nothing and would be a
 *     second thing to keep working.
 *   · `reminderEmail` — a pre-expiry reminder belongs to an anonymous draft
 *     whose publisher has no account to be reminded through. An owner has one.
 *
 * zod strips unknown keys, so a body carrying either field is accepted and the
 * field ignored — a browser posting a multipart form it built for the landing
 * page must not fail here for sending a token nothing needs.
 */
export const ownerPageBodySchema = publishRequestSchema.pick({ html: true });

/**
 * The page is not in a state whose bytes may be replaced.
 *
 * `quarantined` and `under_review` are E07's flags and E06 writes neither:
 * swapping the contents of a flagged page for something else is precisely the
 * evasion the flag exists to stop. `archived` and `expired` are refused for a
 * plainer reason — they are not being served, so a replace would write bytes
 * nobody can reach and quietly repoint a row its owner cannot see.
 */
export class SiteNotReplaceableError extends StudioRefusal {
  constructor(public readonly status: SiteStatus) {
    super("not_allowed_in_status", explainNotReplaceable(status));
    this.name = "SiteNotReplaceableError";
  }
}

function explainNotReplaceable(status: SiteStatus): string {
  // The flagged-page sentence lives once, in `./display.ts`, because the card,
  // the detail screen and this refusal must all say the same thing — an owner
  // who reads one explanation on screen and a different one in an error body
  // learns that neither is authoritative.
  const restricted = managementRefusal(status);
  if (restricted) return restricted;

  switch (status) {
    case "archived":
      return "This page has been deleted, so there is nothing to replace.";
    case "expired":
      return "This page has expired and is not being served. Keep it again first, then replace it.";
    default:
      return "This page cannot be replaced right now.";
  }
}

/**
 * A store step left the edge in a state the caller should retry rather than
 * accept. Both verbs raise it, so the log detail names which one failed.
 *
 * On a replace the row has already been rolled back and the previous manifest
 * restored, so the page is still serving what it was; on a delete nothing has
 * been written at all. Either way the honest answer is "nothing changed, try
 * again", never "we half-deleted your page".
 */
export class ManageStoreError extends StudioRefusal {
  constructor(
    public readonly verb: "replace" | "delete",
    detail: string,
  ) {
    super(
      "internal_error",
      verb === "replace"
        ? "kept could not publish the new file just now. Nothing changed — the page is still serving what it was. Try again in a moment."
        : "kept could not take this page off the internet just now. Nothing changed — it is still serving. Try again in a moment.",
      `The ${verb} could not be applied at the edge: ${detail}`,
    );
    this.name = "ManageStoreError";
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Swap a page's bytes, keeping its URL, its slug, its `siteId` and its clock.
 *
 * The caller (`./owner-routes.ts`) has already validated the body's shape and
 * run the content heuristics; this function owns ownership, state and ordering.
 *
 * @throws {SiteNotFoundError} the page does not exist or is not this profile's
 * @throws {SiteNotReplaceableError} the page is not `live`
 * @throws {ManageStoreError} the new bytes could not be published to the edge
 */
export async function replaceSite(
  siteId: string,
  profileId: string,
  html: string,
): Promise<ReplaceResult> {
  const site = await findSiteForOwner(siteId, profileId);
  if (!site) throw new SiteNotFoundError(siteId);
  if (site.status !== "live") throw new SiteNotReplaceableError(site.status);

  const contentHash = await hashContent(html);
  const sizeBytes = Buffer.byteLength(html, "utf8");
  // RE-EXTRACTED, NOT CARRIED OVER — including to `null`, when the replacement
  // has no readable `<title>`. The name belongs to the bytes, so new bytes get
  // a new name; leaving the old value in place would make the wall confidently
  // display the PREVIOUS page's name (E06 task 001). Unless the OWNER named the
  // page (D11): `insertReplacementVersion` keeps an owner title, in SQL, and
  // returns the title the row actually ended up with.
  const extracted = extractPageTitle(html);

  // NEW versionId, SAME siteId — so the object is a new key rather than a
  // mutation of one the edge may have cached, and the slug never has to move.
  const versionId = crypto.randomUUID();
  const r2Key = pageObjectKey(site.id, versionId);

  const previous = {
    versionId: site.currentVersionId,
    title: site.title,
    contentHash: site.contentHash,
    sizeBytes: site.sizeBytes,
  };

  // Postgres first, exactly as publish does and for the same reason: it is the
  // only store with a transaction and the only one E07's audit can reconcile
  // against. `expires_at` and `purge_after` are not in this statement.
  const { title } = await insertReplacementVersion({
    siteId: site.id,
    versionId,
    r2Key,
    title: extracted,
    contentHash,
    sizeBytes,
    publishedVia: "studio",
  });

  const stored = await writePageAndManifest({
    slug: site.slug,
    siteId: site.id,
    versionId,
    r2Key,
    html,
    ownerId: profileId,
    // The unwind RESTORES this version's manifest rather than removing it: a
    // failed replace must leave the page serving what it served before, never
    // dark. That branch is `writePageAndManifest`'s and exists for this call.
    previousVersionId: previous.versionId ?? undefined,
  });

  if (!stored.ok) {
    console.error(
      `[kept] owner replace: store write failed for site ${site.id} (slug "${site.slug}", object "${r2Key}") — ${stored.error}`,
    );
    try {
      await revertReplacementVersion({ siteId: site.id, versionId, previous });
    } catch (err) {
      console.error(
        `[kept] ROLLBACK INCOMPLETE — site ${site.id} (slug "${site.slug}") still points at version ${versionId}: ${message(err)}. E07 DIVERGENCE AUDIT: Postgres is the authority, never an R2 list (contract §7.5).`,
      );
    }
    throw new ManageStoreError("replace", stored.error);
  }

  // Fire and forget by contract — the new bytes are already live and a scan
  // must never delay or fail the response. A path that stores new bytes without
  // this is a hole big enough to publish anything through: publish clean, then
  // replace with the payload.
  void enqueueScan(site.id, versionId);

  return {
    siteId: site.id,
    slug: site.slug,
    liveUrl: liveUrl(site.slug),
    versionId,
    title,
    // The clock as it was found. Echoed, never recomputed — see the note on
    // `ReplaceResult.expiresAt`.
    expiresAt: site.expiresAt ? site.expiresAt.toISOString() : null,
  };
}

/**
 * Stop serving one owned page and archive it.
 *
 * ⚠️ THE EDGE COMES OFF FIRST. `removeManifest` (pointer → KV → purge) runs
 * before `archiveSite`, so the worst case is a row that still says `live` for a
 * page that no longer serves — visible to an audit, invisible to the internet —
 * instead of a row that says gone while the page keeps answering.
 *
 * ⚠️ NOTHING IS DESTROYED. No `deleteSiteCascade`, no R2 delete, no version
 * removed. E07's grace-end job is what eventually collects the bytes, and it
 * selects on `purge_after` — which `archiveSite` deliberately leaves intact.
 *
 * Idempotent: an already-archived page short-circuits to success rather than a
 * 404 or a second purge, because a retrying client or a double-clicked button
 * must not see an error for reaching the state it asked for.
 *
 * A `quarantined` page CAN be deleted, and that is deliberate — delete is one
 * of the two affordances a flagged page keeps.
 *
 * @throws {SiteNotFoundError} the page does not exist or is not this profile's
 * @throws {ManageStoreError} the page could not be taken off the edge
 */
export async function deleteSite(
  siteId: string,
  profileId: string,
): Promise<DeleteResult> {
  const site = await findSiteForOwner(siteId, profileId);
  if (!site) throw new SiteNotFoundError(siteId);

  if (site.status !== "archived") {
    const removed = await removeManifest(site.slug);
    if (!removed.ok) {
      console.error(
        `[kept] owner delete: manifest removal failed at the "${removed.step}" step for site ${site.id} (slug "${site.slug}") — ${removed.error}. The page is still serving; the row is untouched so the caller can retry.`,
      );
      throw new ManageStoreError("delete", `${removed.step}: ${removed.error}`);
    }
    // `removed.purge.ok === false` is NOT a failure (contract §3): both stores
    // agree the slug is gone and the edge is merely stale until the logged
    // retry lands. `removeManifest` has already logged it.

    try {
      await archiveSite(site.id);
    } catch (err) {
      // The page has already stopped serving, which is what the caller asked
      // for, but the row still says `live`. Loud, because only an audit sees it.
      console.error(
        `[kept] owner delete: manifest removed but site ${site.id} (slug "${site.slug}") failed to archive — ${message(err)}. The page is NOT serving; the row disagrees. E07 DIVERGENCE AUDIT: reconcile against Postgres (contract §7.5).`,
      );
      throw err;
    }
  }

  return {
    siteId: site.id,
    slug: site.slug,
    status: "archived",
    // Counted AFTER the status moved, so the freed slot is in the number the
    // dashboard repaints from. `keptQuotaFor` is the same function the cap
    // branch enforces with — a second count here would be the drift
    // `isKeptCondition` exists to prevent.
    quota: await keptQuotaFor(profileId),
  };
}
