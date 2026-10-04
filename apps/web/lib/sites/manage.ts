/**
 * Replace and delete, for a signed-in owner — E06 task 006; versions (no-op,
 * pruning) E06 task 007. Restore is `./restore.ts`, kept apart so it can be
 * shown, at source level, to write no page bytes (AC28).
 *
 * ── TWO VERBS, TWO DELIBERATELY INVERSE ORDERINGS ────────────────────────────
 *
 *   replace:  Postgres (new version) → R2 object → pointer → KV → purge
 *             → scan → prune (R2 delete THEN row, per pruned version)
 *   delete:   pointer → KV → purge   → Postgres (archive + purge_after + hold)
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
 * 2. **Deleting a page archives it** (D14): `status → 'archived'`, `purge_after
 *    → now + DRAFT_GRACE_DAYS`, a chosen name held; the row, the R2 object and
 *    the versions stay for the owner's download window. The slot frees because
 *    `isKeptCondition` excludes `archived`. Owners reach `archived`; `removed`
 *    is E07's.
 *
 * ⚠️ R2 IS KEYED BY `siteId`, NEVER BY SLUG. A replace writes a NEW `versionId`
 * under the SAME `siteId`; a delete removes no object at all. The only objects
 * this module deletes are versions pruned past `limitsFor(plan).previousVersions`
 * (D7) — the object first, then its row. A failed object delete keeps the row
 * (edge case 14), so the next replace's prune finds it and tries again; the
 * reverse order would orphan bytes no row names.
 */
import {
  hashContent,
  publishRequestSchema,
  type DeleteResult,
  type ReplaceResult,
  type SiteStatus,
} from "@kept/shared";
import { and, eq } from "drizzle-orm";

import { db } from "../db";
import {
  findSiteForOwner,
  insertReplacementVersion,
  revertReplacementVersion,
} from "../db/queries/publish";
import { deleteVersionRow, lockPrunableVersions } from "../db/queries/versions";
import { sites } from "../db/schema";
import { claimsItsName } from "../names/availability";
import { holdName } from "../names/holds";
import { enqueueScan } from "../publish/hooks";
import { extractPageTitle } from "../publish/page-title";
import { graceEnds, liveUrl, writePageAndManifest } from "../publish/pipeline";
import { removeManifest } from "../storage/manifest";
import { pageObjectKey, r2Store } from "../storage/r2";

import { managementRefusal } from "./display";
import { keptQuotaFor, lockOwner, SiteNotFoundError } from "./keep";
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
 * The page is not in a state whose served version may change — by replace or by
 * restore (PRD §5.2: both only on `live`; AC29).
 *
 * `quarantined` and `under_review` are E07's flags and E06 writes neither:
 * swapping the contents of a flagged page for something else is precisely the
 * evasion the flag exists to stop. `archived` and `expired` are refused for a
 * plainer reason — they are not being served, so either verb would repoint a
 * row at bytes nobody can reach. `removed` never gets here: to its owner it is
 * not found.
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
      return "This page has been deleted, so its file can't be changed.";
    case "expired":
      return "This page has expired and is not being served. Keep it again first, then change its file.";
    default:
      return "This page's file can't be changed right now.";
  }
}

/**
 * A store step left the edge in a state the caller should retry rather than
 * accept. Replace, restore (`./restore.ts`) and delete raise it, so the log
 * detail names which one failed.
 *
 * On a replace or a restore the row has already been rolled back and the
 * previous manifest restored, so the page is still serving what it was; on a
 * delete nothing has been written at all. Either way the honest answer is
 * "nothing changed, try again", never "we half-deleted your page".
 */
const STORE_FAILURE_MESSAGE = {
  replace:
    "kept could not publish the new file just now. Nothing changed — the page is still serving what it was. Try again in a moment.",
  restore:
    "kept could not switch to that version just now. Nothing changed — the page is still serving what it was. Try again in a moment.",
  delete:
    "kept could not take this page off the internet just now. Nothing changed — it is still serving. Try again in a moment.",
} as const;

export class ManageStoreError extends StudioRefusal {
  constructor(
    public readonly verb: keyof typeof STORE_FAILURE_MESSAGE,
    detail: string,
  ) {
    super(
      "internal_error",
      STORE_FAILURE_MESSAGE[verb],
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
 * Bytes identical to the current version are `{ unchanged: true }` with nothing
 * written (D7, AC27). Otherwise the answer names the version it replaced — what
 * the Undo toast restores — and whether pruning dropped one.
 *
 * @throws {SiteNotFoundError} the page does not exist, is not this profile's, or is `removed`
 * @throws {SiteNotReplaceableError} the page is not `live`
 * @throws {ManageStoreError} the new bytes could not be published to the edge
 */
export async function replaceSite(
  siteId: string,
  profileId: string,
  html: string,
): Promise<ReplaceResult> {
  const site = await findSiteForOwner(siteId, profileId);
  // `removed` is E07's takedown: to its owner the page no longer exists (§5.2).
  if (!site || site.status === "removed") throw new SiteNotFoundError(siteId);
  if (site.status !== "live") throw new SiteNotReplaceableError(site.status);

  const contentHash = await hashContent(html);
  // `sites.content_hash` is the CURRENT version's (`pointSiteAt` keeps it so).
  // Re-dropping the file already served is not a new version, and writing one
  // would push a real previous version out through pruning for nothing.
  if (contentHash === site.contentHash) return { unchanged: true };

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
    unchanged: false,
    siteId: site.id,
    slug: site.slug,
    liveUrl: liveUrl(site.slug),
    versionId,
    previousVersionId: previous.versionId,
    title,
    // The clock as it was found. Echoed, never recomputed — see the note on
    // `expiresAt` in `@kept/shared`'s replace/restore result.
    expiresAt: site.expiresAt ? site.expiresAt.toISOString() : null,
    // LAST, after the new version is live: a prune decides against the
    // current pointer, and must never be the reason a replace failed.
    pruned: await pruneVersions(site.id),
  };
}

/**
 * Keep the current version plus `limitsFor(plan).previousVersions` (D7), newest
 * by `activated_at`; drop the rest — each R2 object FIRST, then its row.
 *
 * Runs under the site-row lock `lockPrunableVersions` takes, which is the lock a
 * restore takes too, so a restore can never point the page at bytes being
 * deleted here.
 *
 * A failed object delete keeps its row and logs, and the next replace retries it
 * (edge case 14). NEVER THROWS: the new version is already serving, and a
 * prune that failed must not turn a successful replace into an error. The
 * answer is whether a version was dropped — the studio's cue for "Free accounts
 * keep one previous version." (task 012).
 */
async function pruneVersions(siteId: string): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      const r2 = r2Store();
      let pruned = false;
      for (const version of await lockPrunableVersions(tx, siteId)) {
        try {
          await r2.delete(version.r2Key);
        } catch (err) {
          console.error(
            `[kept] prune: R2 delete failed for "${version.r2Key}" (site ${siteId}) — ${message(err)}. The row is kept; the next replace retries it.`,
          );
          continue;
        }
        await deleteVersionRow(tx, siteId, version.id);
        pruned = true;
      }
      return pruned;
    });
  } catch (err) {
    console.error(
      `[kept] prune failed for site ${siteId} — ${message(err)}. Older versions are kept; the next replace retries.`,
    );
    return false;
  }
}

/**
 * The columns of the one end state an owner can reach (D14, D16): `archived`,
 * downloadable by its owner until `purge_after = now + DRAFT_GRACE_DAYS`, then
 * E07's purge. Owners reach `archived`; `removed` is E07's.
 *
 * `purge_after` is set even on a draft whose clock had a later deadline: the
 * download window starts at the delete, and a NULL here is a page E07 never
 * collects (latent bug 3).
 */
export function archivedForGrace(now = new Date()) {
  return { status: "archived" as const, purgeAfter: graceEnds(now) };
}

/**
 * Stop serving one owned page and archive it (D14).
 *
 * ⚠️ THE EDGE COMES OFF FIRST. `removeManifest` (pointer → KV → purge) runs
 * before the row moves, so the worst case is a row that still says `live` for a
 * page that no longer serves — visible to an audit, invisible to the internet —
 * instead of a row that says gone while the page keeps answering.
 *
 * ⚠️ NOTHING IS DESTROYED. No R2 delete, no version removed: the owner may
 * download the page until `purge_after`, and E07's purge collects the bytes
 * after it.
 *
 * The row moves under `lockOwner`, then a CHOSEN name is held for the owner
 * (`holdName`, which takes the name's advisory lock — lockOwner first, then the
 * name, the order `../names/availability.ts` fixes). A generated name is not
 * held. Idempotent: an already-archived page short-circuits to success, and a
 * concurrent second delete finds no row left to move — either way no second
 * hold and no second `purge_after`, because a retrying client or a
 * double-clicked button must not see an error for reaching the state it asked
 * for.
 *
 * A `quarantined` page CAN be deleted, and that is deliberate — delete is one
 * of the two affordances a flagged page keeps.
 *
 * @throws {SiteNotFoundError} the page does not exist, is not this profile's, or is `removed`
 * @throws {ManageStoreError} the page could not be taken off the edge
 */
export async function deleteSite(
  siteId: string,
  profileId: string,
): Promise<DeleteResult> {
  const site = await findSiteForOwner(siteId, profileId);
  // `removed` is E07's takedown: to its owner the page no longer exists (§5.2),
  // and a delete must never turn it into `archived`.
  if (!site || site.status === "removed") throw new SiteNotFoundError(siteId);

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
      await db.transaction(async (tx) => {
        await lockOwner(tx, profileId);
        const [archived] = await tx
          .update(sites)
          .set(archivedForGrace())
          .where(and(eq(sites.id, site.id), eq(sites.ownerId, profileId), claimsItsName()))
          .returning({ slug: sites.slug, nameKind: sites.nameKind });
        if (archived?.nameKind === "chosen") {
          await holdName(archived.slug, profileId, "deleted", site.id, tx);
        }
      });
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
