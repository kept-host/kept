/**
 * Publishing as a signed-in owner — `POST /api/sites`, decision **D9**.
 *
 * ── WHY THIS IS A THIRD VERB AND NOT A COMPOSITION OF TWO EXISTING ONES ──────
 *
 *   WRONG:  POST /api/publish  →  POST /api/anon/:token/keep
 *   RIGHT:  POST /api/sites     (one request, one transaction, one authority)
 *
 * The wrong shape is two non-atomic requests with a window between them. A
 * failure in that window leaves a page the user believes they own, holding a
 * bearer token in a browser tab, with the account's quota untouched — and it
 * routes an authenticated user through the KEYLESS endpoint, which is the one
 * path E07's volume governors exist to throttle. So the row is owned at insert
 * time, **no `anon_token_hash` is ever minted**, and there is no second
 * authority on the page to revoke afterwards.
 *
 * ── WHAT IS REUSED, VERBATIM ─────────────────────────────────────────────────
 * The store half is `storeNewPage` from `lib/publish/pipeline.ts` — the every
 * file → pointer → KV → purge sequence and its unwind, in the one place it is
 * written down. The clocks are `draftClocks`, the URL is `liveUrl`, the name is
 * `setTitle`, the scan is the same `./hooks` seam, the caps are the owner's
 * plan's through the same `readFileSet` (the route reads it), and the slug
 * comes out of the same generate-and-retry loop (`withMintedSlug`: the namespace
 * check, then `sites_slug_key`). Nothing about the ordering is re-derived here. The version
 * row records `published_via = 'studio'` (§5.9).
 *
 * ── WHAT DIFFERS, AND IT IS ONLY THIS ────────────────────────────────────────
 *   1. `owner_id` is set by the INSERT, and `anon_token_hash` never is.
 *   2. The cap is decided INSIDE the insert's transaction, on `lockOwner` — the
 *      same serialisation point `keepSite` uses — and it is the OWNER'S PLAN's
 *      cap (`limitsFor(plan)` via `keptQuotaFor`, which reads `profiles.plan`
 *      off the row `lockOwner` holds). Under the cap the page is kept (no
 *      clocks); at the cap it lands as an owned draft (both clocks set).
 *      **Never a 4xx for being full**, and there must never be one.
 *   3. Dedup is by OWNER, not by publisher (PRD §5.1, AC8): the same bytes
 *      published twice by one account are ONE page. If the account already has
 *      an active page (`OWNER_DEDUP_STATUSES`, clock not run out) with this
 *      content hash, nothing is written and the existing page comes back with
 *      `duplicate: true`. The probe runs INSIDE the `lockOwner` transaction, so
 *      two identical publishes from two tabs queue on the lock and the second
 *      finds the first's row. No token rotates: an owned page has none.
 *   4. There is no Turnstile check. The caller is authenticated by a `__Host-`
 *      session cookie and an origin check; a bot check on top of that protects
 *      nothing and would be a second thing to keep working.
 *   5. `checkRateLimit` is NOT called, and that is a decision rather than an
 *      omission. Its key is a salted hash of IP + user agent, built to throttle
 *      keyless publishing where there is no other identity; applying it to a
 *      signed-in account would throttle by the wrong subject (an office NAT is
 *      one publisher hash and many accounts). `publisher_hash` is still RECORDED
 *      on every row here, which is what E07 needs to decide the authenticated
 *      policy — governing an account is E07's to write, against `owner_id`.
 *
 * ⚠️ NO HTTP IN THIS FILE, and no zod. The route reads the body into a
 * `FileSet`, `./owner-routes.ts` maps failures onto statuses; this module owns
 * the cap, the database and the store ordering. Same split as `./rename.ts` and
 * `./manage.ts`.
 */
import { type OwnedPublishResult, type StudioSite } from "@kept/shared";

import { db } from "../db";
import {
  deleteSiteCascade,
  findOwnedDuplicate,
  insertOwnedPage,
  withMintedSlug,
  type PendingVersionInput,
} from "../db/queries/publish";
import type { FileSet } from "../publish/fileset/types";
import { enqueueScan } from "../publish/hooks";
import {
  DEFAULT_SOURCE,
  draftClocks,
  pendingVersion,
  publisherHashOf,
  setTitle,
  storeNewPage,
  type PublisherContext,
  type PublishSource,
} from "../publish/pipeline";
import type { StoredProvenance } from "../publish/provenance";
import { refreshReadmePage } from "../readme/page";

import { keptQuotaFor, lockOwner } from "./keep";
import { StudioRefusal } from "./studio-refusal";
import { readStudioSite } from "./studio-site";

/**
 * The bytes could not be published to the edge, and the row has been rolled
 * back. Nothing is half-written, so the honest answer is "retry".
 */
export class OwnedPublishStoreError extends StudioRefusal {
  constructor(detail: string) {
    super(
      "internal_error",
      "kept could not publish this page just now. Nothing was left half-written — try again in a moment.",
      `The page could not be published to the edge: ${detail}`,
    );
    this.name = "OwnedPublishStoreError";
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What the transaction decided: the page it inserted, or the one it already had. */
interface Landed {
  site: StudioSite;
  duplicate: boolean;
}

/**
 * The dedup probe, the cap decision and the insert, in ONE transaction, retried
 * on a slug collision with a fresh candidate.
 *
 * ⚠️ THE RETRY RE-OPENS THE TRANSACTION, WHICH RE-TAKES THE LOCK. A collision
 * aborts the transaction in Postgres, so the attempt cannot be continued in
 * place — and re-locking is correct rather than merely necessary: the probe and
 * the cap must be decided against the state that exists when the row is finally
 * written, not against a snapshot taken before another tab's publish committed.
 *
 * The `site` it returns is read back inside the lock, so its clocks and
 * `updatedAt` are the row's, never a second computation of them.
 */
async function insertWithMintedSlug(input: {
  version: PendingVersionInput;
  ownerId: string;
  publisherHash: string;
  title: string | null;
  provenance: StoredProvenance;
}): Promise<Landed> {
  return withMintedSlug((slug) =>
    db.transaction(async (tx): Promise<Landed> => {
      // THE SERIALISATION POINT. Everything below reads and writes behind it.
      await lockOwner(tx, input.ownerId);

      // Behind the lock, so an identical publish from another tab has either
      // committed (and is found here) or is queued behind this one.
      const duplicateId = await findOwnedDuplicate(tx, input.ownerId, input.version.contentHash);
      if (duplicateId !== null) {
        return { site: await readStudioSite(tx, duplicateId), duplicate: true };
      }

      // Plan-aware: `keptQuotaFor` reads the plan from the row locked above,
      // so a premium account is measured against its own limit, not the free one.
      const quota = await keptQuotaFor(input.ownerId, tx);
      // The cap DEGRADES, it never errors: out of slots means this page lands
      // as an owned draft with a countdown, not a refused publish.
      const clocks = quota.remaining > 0 ? null : draftClocks(new Date());

      await insertOwnedPage(tx, {
        version: input.version,
        slug,
        ownerId: input.ownerId,
        publisherHash: input.publisherHash,
        title: input.title,
        provenance: input.provenance,
        expiresAt: clocks?.expiresAt ?? null,
        purgeAfter: clocks?.purgeAfter ?? null,
        // The page is this account's from its first byte, so the stamp that
        // records when it stopped being anonymous is its creation.
        claimedAt: new Date(),
      });

      return { site: await readStudioSite(tx, input.version.siteId), duplicate: false };
    }),
  );
}

/**
 * Publish a page that belongs to an account from the moment it exists.
 *
 * The caller has already read the body into a `FileSet` on the owner's plan.
 *
 * @returns `{ site }` for a new page, `{ site, duplicate: true }` when this
 *   account already has this set live — nothing is written for a duplicate.
 * @throws {SlugUnavailableError} minting exhausted its attempts — a 503
 * @throws {OwnedPublishStoreError} R2 or KV refused; the row is rolled back
 */
export async function publishOwnedPage(args: {
  profileId: string;
  set: FileSet;
  publisher: PublisherContext;
  /** The `X-Kept-Client` label and, for E09's `/api/v1`, the channel (default `studio`). */
  source?: PublishSource;
}): Promise<OwnedPublishResult> {
  const { profileId, set, publisher, source = DEFAULT_SOURCE } = args;

  // The raw IP is used to compute the digest and then dropped — never stored,
  // never logged. Recorded because an owned publish is still a publish (E07).
  const publisherHash = await publisherHashOf(publisher);

  // Both ids up front, so every R2 key is known before the transaction opens.
  const siteId = crypto.randomUUID();
  const versionId = crypto.randomUUID();

  // POSTGRES COMMITS FIRST, exactly as the anonymous pipeline does and for the
  // same reason: it is the only store with a transaction and the only one E07's
  // divergence audit can reconcile against. The set hash, size and name all
  // come off the in-memory set (D10 — `hashContent(html)` for a single page).
  const landed = await insertWithMintedSlug({
    version: pendingVersion(siteId, versionId, set, source.publishedVia ?? "studio", source.client),
    ownerId: profileId,
    publisherHash,
    title: setTitle(set),
    provenance: set.provenance,
  });

  // The account already has this page. No row, no object, no manifest, no scan:
  // the bytes are already live at the existing page's address.
  if (landed.duplicate) return { site: landed.site, duplicate: true };

  const stored = await storeNewPage({
    slug: landed.site.slug,
    siteId,
    versionId,
    set,
    ownerId: profileId,
  });

  if (!stored.ok) {
    console.error(
      `[kept] owned publish: store write failed for site ${siteId} (slug "${landed.site.slug}", version ${versionId}, ${set.entries.length} files) — ${stored.error}`,
    );
    try {
      await deleteSiteCascade(siteId);
    } catch (err) {
      console.error(
        `[kept] ROLLBACK INCOMPLETE — orphan rows for site ${siteId} (slug "${landed.site.slug}"): ${message(err)}. E07 DIVERGENCE AUDIT: Postgres is the authority, never an R2 list (contract §7.5).`,
      );
    }
    throw new OwnedPublishStoreError(stored.error);
  }

  // A page that landed kept with a README (E10 D6, Q6) gets its README page now
  // that the manifest naming it is written. A brand-new URL has nothing cached.
  if (landed.site.expiresAt === null) await refreshReadmePage(siteId);

  // Fire and forget by contract: the page is already live and a scan must never
  // delay or fail the response. The same seam, in the same position, as every
  // other path that stores bytes.
  void enqueueScan(siteId, versionId, "publish");

  return { site: landed.site };
}
