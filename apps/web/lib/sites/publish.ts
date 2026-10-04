/**
 * Publishing as a signed-in owner — E06 task 004, epic decision **D1**.
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
 * The store half is `writePageAndManifest` from `lib/publish/pipeline.ts` — the
 * R2 → pointer → KV → purge sequence and its unwind, in the one place it is
 * written down. The clocks are `draftClocks`, the URL is `liveUrl`, the name is
 * `extractPageTitle`, the content check and the scan are the same `./hooks`
 * seams, the size cap is `MAX_PAGE_BYTES` through the same schema, and the slug
 * is `mintSlugCandidate` with the same generate-and-retry against
 * `sites_slug_key`. Nothing about the ordering is re-derived here.
 *
 * ── WHAT DIFFERS, AND IT IS ONLY THIS ────────────────────────────────────────
 *   1. `owner_id` is set by the INSERT, and `anon_token_hash` never is.
 *   2. The cap is decided INSIDE the insert's transaction, on `lockOwner` — the
 *      same serialisation point `keepSite` uses — and it is the OWNER'S PLAN's
 *      cap (`limitsFor(plan)` via `keptQuotaFor`, which reads `profiles.plan`
 *      off the row `lockOwner` holds). Under the cap the page is kept (no
 *      clocks); at the cap it lands as an owned draft (both clocks set).
 *      **Never a 4xx for being full**, and there must never be one.
 *   3. There is no dedup probe. Dedup exists so an agent's retry loop converges
 *      on ONE anonymous page, and it works by rotating that page's bearer token
 *      — a mechanism this path has no token for. A signed-in user who publishes
 *      the same bytes twice asked for two pages and gets two pages.
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
 * ⚠️ NO HTTP IN THIS FILE, and no zod. `./owner-routes.ts` validates the body,
 * runs the content heuristic and maps failures onto statuses; this module owns
 * the cap, the database and the store ordering. Same split as `./rename.ts` and
 * `./manage.ts`.
 */
import { hashContent, hashPublisher, type OwnedPublishResult } from "@kept/shared";

import { db } from "../db";
import {
  deleteSiteCascade,
  insertOwnedPage,
  isSlugCollision,
  MAX_SLUG_ATTEMPTS,
  SlugUnavailableError,
} from "../db/queries/publish";
import { enqueueScan } from "../publish/hooks";
import { extractPageTitle } from "../publish/page-title";
import {
  draftClocks,
  liveUrl,
  writePageAndManifest,
  type PublisherContext,
} from "../publish/pipeline";
import { mintSlugCandidate } from "../publish/slug";
import { publisherHashSalt } from "../storage/env";
import { pageObjectKey } from "../storage/r2";

import { keptQuotaFor, lockOwner } from "./keep";

/**
 * The bytes could not be published to the edge, and the row has been rolled
 * back. Mapped to the publish family's 500 — nothing is half-written, so the
 * honest answer is "retry", the same one `publishPage` gives for the same
 * failure.
 */
export class OwnedPublishStoreError extends Error {
  constructor(detail: string) {
    super(`The page could not be published to the edge: ${detail}`);
    this.name = "OwnedPublishStoreError";
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What the transaction decided: the name it took, and the cap branch it landed. */
interface LandedRow {
  slug: string;
  /** `null` ⇒ kept. Set ⇒ the account was at the cap and this is an owned draft. */
  clocks: { expiresAt: Date; purgeAfter: Date } | null;
  /** Counted AFTER the insert, so it already includes this page. */
  quota: Awaited<ReturnType<typeof keptQuotaFor>>;
}

/**
 * The cap decision and the insert, in ONE transaction, retried on a slug
 * collision with a fresh candidate.
 *
 * ⚠️ THE RETRY RE-OPENS THE TRANSACTION, WHICH RE-TAKES THE LOCK. A collision
 * aborts the transaction in Postgres, so the attempt cannot be continued in
 * place — and re-locking is correct rather than merely necessary: the cap must
 * be decided against the state that exists when the row is finally written, not
 * against a snapshot taken before another tab's publish committed.
 *
 * The quota is read TWICE inside the lock, on purpose. The first read decides
 * the branch; the second, after the insert, is the number the dashboard
 * repaints from — it sees this page and needs no arithmetic to say so. Deriving
 * the second from the first would be a second implementation of the cap
 * arithmetic that `keptQuotaFor` exists to hold once.
 */
async function insertWithMintedSlug(input: {
  siteId: string;
  versionId: string;
  ownerId: string;
  publisherHash: string;
  title: string | null;
  contentHash: string;
  sizeBytes: number;
}): Promise<LandedRow> {
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = mintSlugCandidate();
    try {
      return await db.transaction(async (tx) => {
        // THE SERIALISATION POINT. Everything below reads and writes behind it.
        await lockOwner(tx, input.ownerId);

        // Plan-aware: `keptQuotaFor` reads the plan from the row locked above,
        // so a premium account is measured against its own limit, not the free one.
        const before = await keptQuotaFor(input.ownerId, tx);
        // The cap DEGRADES, it never errors: out of slots means this page lands
        // as an owned draft with a countdown, not a refused publish.
        const clocks = before.remaining > 0 ? null : draftClocks(new Date());

        await insertOwnedPage(tx, {
          siteId: input.siteId,
          versionId: input.versionId,
          slug,
          r2Key: pageObjectKey(input.siteId, input.versionId),
          ownerId: input.ownerId,
          publisherHash: input.publisherHash,
          title: input.title,
          contentHash: input.contentHash,
          sizeBytes: input.sizeBytes,
          expiresAt: clocks?.expiresAt ?? null,
          purgeAfter: clocks?.purgeAfter ?? null,
          // The page is this account's from its first byte, so the stamp that
          // records when it stopped being anonymous is its creation.
          claimedAt: new Date(),
        });

        return { slug, clocks, quota: await keptQuotaFor(input.ownerId, tx) };
      });
    } catch (err) {
      if (!isSlugCollision(err)) throw err;
    }
  }
  throw new SlugUnavailableError();
}

/**
 * Publish a page that belongs to an account from the moment it exists.
 *
 * The caller has already validated the body and run the content heuristics.
 *
 * @throws {SlugUnavailableError} minting exhausted its attempts — a 503
 * @throws {OwnedPublishStoreError} R2 or KV refused; the row is rolled back
 */
export async function publishOwnedPage(args: {
  profileId: string;
  html: string;
  publisher: PublisherContext;
}): Promise<OwnedPublishResult> {
  const { profileId, html, publisher } = args;

  // Over the exact bytes that will be stored, and read ONCE: the hash, the
  // size and the name all come off this same in-memory buffer.
  const contentHash = await hashContent(html);
  const sizeBytes = Buffer.byteLength(html, "utf8");
  const title = extractPageTitle(html);

  // The raw IP is used to compute the digest and then dropped — never stored,
  // never logged. Recorded because an owned publish is still a publish (E07).
  const publisherHash = await hashPublisher(
    publisher.ip,
    publisher.userAgent,
    publisherHashSalt(),
  );

  // Both ids up front, so the R2 key is known before the transaction opens.
  const siteId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const r2Key = pageObjectKey(siteId, versionId);

  // POSTGRES COMMITS FIRST, exactly as the anonymous pipeline does and for the
  // same reason: it is the only store with a transaction and the only one E07's
  // divergence audit can reconcile against.
  const landed = await insertWithMintedSlug({
    siteId,
    versionId,
    ownerId: profileId,
    publisherHash,
    title,
    contentHash,
    sizeBytes,
  });

  const stored = await writePageAndManifest({
    slug: landed.slug,
    siteId,
    versionId,
    r2Key,
    html,
    ownerId: profileId,
  });

  if (!stored.ok) {
    console.error(
      `[kept] owned publish: store write failed for site ${siteId} (slug "${landed.slug}", object "${r2Key}") — ${stored.error}`,
    );
    try {
      await deleteSiteCascade(siteId);
    } catch (err) {
      console.error(
        `[kept] ROLLBACK INCOMPLETE — orphan rows for site ${siteId} (slug "${landed.slug}"): ${message(err)}. E07 DIVERGENCE AUDIT: Postgres is the authority, never an R2 list (contract §7.5).`,
      );
    }
    throw new OwnedPublishStoreError(stored.error);
  }

  // Fire and forget by contract: the page is already live and a scan must never
  // delay or fail the response. The same seam, in the same position, as every
  // other path that stores bytes.
  void enqueueScan(siteId, versionId);

  const common = {
    siteId,
    slug: landed.slug,
    liveUrl: liveUrl(landed.slug),
    title,
    quota: landed.quota,
  };

  return landed.clocks === null
    ? { outcome: "kept", ...common }
    : {
        outcome: "owned_draft",
        ...common,
        expiresAt: landed.clocks.expiresAt.toISOString(),
        purgeAfter: landed.clocks.purgeAfter.toISOString(),
      };
}
