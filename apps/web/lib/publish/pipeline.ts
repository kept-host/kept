/**
 * The anonymous publish pipeline — E04 task 005.
 *
 * The first request in the product that touches all four stores, and the reason
 * their ordering is written down in `docs/edge-purge-contract.md`:
 *
 *   validate → E07 hooks → content_hash → dedup probe → Postgres tx
 *     → R2 page object → writeManifest(pointer → KV → purge)
 *
 * NO HTTP IN THIS FILE. `publishPage` takes an already-extracted body and a
 * publisher identity and returns an outcome; `app/api/publish/route.ts` is a
 * thin boundary over it that knows about `Request`, content types and status
 * codes, and nothing else. That split is what lets the whole pipeline be
 * exercised from a test with no server running — and it is also why the API is
 * the product rather than an accident of the landing page: E08's MCP tools and
 * the hero are two callers of the same function.
 *
 * WHY POSTGRES COMMITS FIRST. Four stores, no distributed transaction, so
 * something has to be the authority. Postgres is: it is the only one with a
 * transaction, the only one E07's divergence audit can reconcile against, and
 * the only one that can express "this row exists but its bytes do not".
 * Committing it first makes every later failure a KNOWN inconsistency with a
 * defined unwind, instead of an object in R2 that nobody can name.
 *
 * AND WHY THE UNWIND RUNS IN REVERSE. Pointer, then object, then rows. While a
 * pointer still names a site the Worker can serve it on a KV miss, so the
 * pointer has to go first; while the rows still exist, the stores can at least
 * be explained. The one genuinely unrecoverable interleaving — KV written,
 * rollback itself failing — is logged loudly enough for E07's audit to find,
 * and that audit's authority is Postgres, NEVER an R2 `list` (contract §7.5).
 *
 * A FAILED PURGE IS NOT A FAILED PUBLISH (contract §3). The write already
 * succeeded and the page is correct; only the edge is stale, and it is stale
 * until a retry lands. `writeManifest` logs it; this pipeline returns 201.
 */
import {
  DRAFT_GRACE_DAYS,
  DRAFT_TTL_DAYS,
  MAX_PAGE_BYTES,
  generateAnonToken,
  hashContent,
  hashPublisher,
  hashToken,
  publishRequestSchema,
  publishResponseSchema,
  type KvManifest,
  type PublishError,
  type PublishResponse,
} from "@kept/shared";
import type { z } from "zod";

import {
  claimDedupCandidate,
  deleteSiteCascade,
  insertAnonymousDraft,
  SlugUnavailableError,
} from "../db/queries/publish";
import { appOrigin, publisherHashSalt, servingBaseDomain } from "../storage/env";
import { removeManifest, writeManifest } from "../storage/manifest";
import { PAGE_CONTENT_TYPE, pageObjectKey, r2Store } from "../storage/r2";
import {
  checkHeuristics,
  checkRateLimit,
  enqueueScan,
  verifyTurnstile,
} from "./hooks";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Who is publishing, as far as this request can tell.
 *
 * THE RAW IP IS USED TO COMPUTE A DIGEST AND THEN DISCARDED. It is never
 * written to a column, never logged, never echoed into an error body. Storing
 * visitor IPs on a free-hosting product is a liability with no upside, and the
 * salted hash is a better key for both dedup and E07's rate limiter anyway.
 */
export interface PublisherContext {
  ip: string;
  userAgent: string;
}

export type PublishOutcome =
  | { ok: true; status: 201; body: PublishResponse }
  | { ok: false; status: number; body: PublishError };

function fail(status: number, body: PublishError): PublishOutcome {
  return { ok: false, status, body };
}

/**
 * Map a schema failure onto the closed error enum. The codes are what agents
 * branch on, so "the body was 6 MB" and "the body had no `html` field" must
 * never arrive as the same code — an unparseable error is an infinite retry
 * loop.
 */
function requestError(error: z.ZodError): PublishOutcome {
  const htmlIssue = error.issues.find((issue) => issue.path[0] === "html");

  if (htmlIssue?.code === "too_small") {
    return fail(400, {
      error: "empty_page",
      message: "The page is empty. Send an HTML document in the `html` field.",
    });
  }
  // `pageHtmlSchema`'s byte cap is a `.refine`, which zod reports as `custom`.
  if (htmlIssue?.code === "custom") {
    return fail(413, {
      error: "page_too_large",
      message: `The page is larger than the ${MAX_PAGE_BYTES}-byte limit. kept hosts a single HTML document — inline or trim the largest assets and try again.`,
    });
  }

  const detail = error.issues
    .map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`)
    .join("; ");
  return fail(400, {
    error: "invalid_request",
    message: `The request body is not valid: ${detail}`,
  });
}

/** `expires_at` and `purge_after`, both from `@kept/shared`. No literals. */
export function draftClocks(now: Date): { expiresAt: Date; purgeAfter: Date } {
  const expiresAt = new Date(now.getTime() + DRAFT_TTL_DAYS * MS_PER_DAY);
  return {
    expiresAt,
    purgeAfter: new Date(expiresAt.getTime() + DRAFT_GRACE_DAYS * MS_PER_DAY),
  };
}

/** The public URL of a published slug: `https://{slug}.{KEPT_BASE_DOMAIN}`. */
export function liveUrl(slug: string): string {
  return `https://${slug}.${servingBaseDomain()}`;
}

/** The human-facing keep page on the control plane's own origin. */
export function claimUrl(anonToken: string): string {
  return `${appOrigin()}/keep/${anonToken}`;
}

export type StoreWriteResult =
  | { ok: true }
  | { ok: false; error: string; unwound: boolean };

/**
 * The store half of a publish: **R2 page object → `writeManifest`**, and the
 * exact reverse on failure.
 *
 * Exported because task 006's replace is this same sequence — a replace is a
 * publish minus the mint and minus the row insert — and E06's rename/demote
 * reach the same ordering through `writeManifest` directly. Re-deriving the
 * order at a second call site is how the delete path ends up backwards, where
 * it is invisible until a KV miss resurrects a deleted page.
 *
 * The object write MUST precede the manifest write: the manifest is what makes
 * a slug resolvable, so publishing it before the bytes exist is a window in
 * which the Worker serves a 404 for a page the control plane calls live.
 *
 * `unwound` reports whether the reverse path completed. `false` means the edge
 * and Postgres may now disagree and a human (or E07's audit) has to look.
 */
export async function writePageAndManifest(args: {
  slug: string;
  siteId: string;
  versionId: string;
  r2Key: string;
  html: string;
  ownerId: string | null;
}): Promise<StoreWriteResult> {
  const { slug, siteId, versionId, r2Key, html, ownerId } = args;
  const r2 = r2Store();

  try {
    await r2.put(r2Key, html, PAGE_CONTENT_TYPE);
  } catch (err) {
    // Nothing was written. Nothing to unwind on the store side.
    return { ok: false, error: `page object: ${message(err)}`, unwound: true };
  }

  const manifest: KvManifest = {
    siteId,
    versionId,
    // Drafts are `live`. The clock lives in Postgres and never in the manifest.
    status: "live",
    region: "auto",
    ownerId,
    updatedAt: Date.now(),
  };

  const written = await writeManifest(slug, manifest);
  if (written.ok) {
    // `purge.ok === false` is NOT a failure (contract §3). `writeManifest` has
    // already logged it; the stores agree and the page is correct.
    return { ok: true };
  }

  // Unwind in reverse. `step: "kv"` means the POINTER IS WRITTEN and must be
  // removed; `"validate"` and `"pointer"` mean nothing reached a store.
  const unwound = await unwindStores({
    slug,
    r2Key,
    pointerWritten: written.step === "kv",
  });
  return { ok: false, error: `manifest ${written.step}: ${written.error}`, unwound };
}

async function unwindStores(args: {
  slug: string;
  r2Key: string;
  pointerWritten: boolean;
}): Promise<boolean> {
  let clean = true;

  if (args.pointerWritten) {
    // `removeManifest` is the inverse of the whole sequence — pointer, then KV,
    // then purge — and is safe when the KV key was never written: a KV delete
    // of an absent key is a no-op.
    const removed = await removeManifest(args.slug);
    if (!removed.ok) {
      clean = false;
      console.error(
        `[kept] ROLLBACK INCOMPLETE — slug "${args.slug}" failed to unwind at the "${removed.step}" step: ${removed.error}. A manifest may still resolve this slug with no row behind it. E07 DIVERGENCE AUDIT: reconcile against Postgres, never against an R2 list (contract §7.5).`,
      );
    }
  }

  try {
    await r2Store().delete(args.r2Key);
  } catch (err) {
    clean = false;
    console.error(
      `[kept] ROLLBACK INCOMPLETE — orphan R2 object "${args.r2Key}": ${message(err)}. Unreferenced bytes, not a serving fault; E07's audit reconciles against Postgres.`,
    );
  }

  return clean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Publish a page. The whole endpoint, minus HTTP.
 *
 * @param raw the request body, already extracted from JSON, multipart or a raw
 *   HTML payload by the route handler. Unvalidated on purpose — validation
 *   belongs here, not in the boundary and certainly not in a query.
 */
export async function publishPage(
  raw: unknown,
  publisher: PublisherContext,
): Promise<PublishOutcome> {
  // ── 1. validate ────────────────────────────────────────────────────────────
  const parsed = publishRequestSchema.safeParse(raw);
  if (!parsed.success) return requestError(parsed.error);
  const { html, turnstileToken, reminderEmail } = parsed.data;

  // ── 2. E07 seams ───────────────────────────────────────────────────────────
  // Turnstile ONLY when a token is present: keyless API callers legitimately
  // cannot solve a CAPTCHA, and publishing keyless is the epic's locked
  // decision. See `./hooks`.
  if (turnstileToken !== undefined) {
    const turnstile = await verifyTurnstile(turnstileToken);
    if (!turnstile.ok) {
      return fail(403, {
        error: "turnstile_failed",
        message: `The bot check did not pass (${turnstile.reason}). Reload the page and try again.`,
      });
    }
  }

  const publisherHash = await hashPublisher(
    publisher.ip,
    publisher.userAgent,
    publisherHashSalt(),
  );

  const rate = await checkRateLimit(publisherHash);
  if (!rate.allowed) {
    return fail(429, {
      error: "rate_limited",
      message: `Too many pages published from here (${rate.reason}). Try again in ${rate.retryAfterSeconds} seconds.`,
      retry_after_seconds: rate.retryAfterSeconds,
    });
  }

  const heuristics = await checkHeuristics(html);
  if (!heuristics.allowed) {
    return fail(422, {
      error: "content_rejected",
      message: `This page was refused by the content check (${heuristics.reason}).`,
    });
  }

  // ── 3. content hash ────────────────────────────────────────────────────────
  // Over the exact bytes that will be stored: `hashContent` digests the UTF-8
  // encoding, which is what `r2.put` sends.
  const contentHash = await hashContent(html);
  const sizeBytes = Buffer.byteLength(html, "utf8");

  // One token, used either to rotate the deduped row or to create a new one.
  const anonToken = generateAnonToken();
  const anonTokenHash = await hashToken(anonToken);

  // ── 4. dedup probe ─────────────────────────────────────────────────────────
  const deduped = await claimDedupCandidate({
    publisherHash,
    contentHash,
    anonTokenHash,
  });
  if (deduped) {
    // Same site, same slug, same version, same bytes, same clock — no new row,
    // no new version, no new object, no store write at all. An agent's retry
    // loop converges on ONE page. The token was rotated inside the probe's
    // transaction, so the claim URL below is fresh and the previous one is dead.
    return respond({
      slug: deduped.slug,
      anonToken,
      expiresAt: deduped.expiresAt,
      deduped: true,
    });
  }

  // ── 5. Postgres tx ─────────────────────────────────────────────────────────
  const siteId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const r2Key = pageObjectKey(siteId, versionId);
  const { expiresAt, purgeAfter } = draftClocks(new Date());

  let slug: string;
  try {
    ({ slug } = await insertAnonymousDraft({
      siteId,
      versionId,
      r2Key,
      contentHash,
      sizeBytes,
      anonTokenHash,
      publisherHash,
      expiresAt,
      purgeAfter,
      reminderEmail,
    }));
  } catch (err) {
    if (err instanceof SlugUnavailableError) {
      console.error(`[kept] ${err.message}`);
      return fail(503, {
        error: "slug_unavailable",
        message:
          "Could not assign a link for this page right now. This is transient — retry the request.",
      });
    }
    console.error(`[kept] publish: Postgres write failed — ${message(err)}`);
    return internalError();
  }

  // ── 6–9. object → pointer → KV → purge ─────────────────────────────────────
  const stored = await writePageAndManifest({
    slug,
    siteId,
    versionId,
    r2Key,
    html,
    ownerId: null,
  });

  if (!stored.ok) {
    console.error(
      `[kept] publish: store write failed for site ${siteId} (slug "${slug}", object "${r2Key}") — ${stored.error}`,
    );
    try {
      await deleteSiteCascade(siteId);
    } catch (err) {
      console.error(
        `[kept] ROLLBACK INCOMPLETE — orphan rows for site ${siteId} (slug "${slug}"): ${message(err)}. E07 DIVERGENCE AUDIT: Postgres is the authority, never an R2 list (contract §7.5).`,
      );
    }
    return internalError();
  }

  // Fire and forget by contract: the page is already live and a scan must never
  // delay or fail the response.
  void enqueueScan(siteId, versionId);

  return respond({ slug, anonToken, expiresAt, deduped: false });
}

function internalError(): PublishOutcome {
  return fail(500, {
    error: "internal_error",
    message:
      "kept could not publish this page. Nothing was left half-written — retry the request.",
  });
}

/**
 * Build and VALIDATE the 201 body before it leaves. The response schema is
 * shared because E08's MCP server wraps this contract without modifying it;
 * parsing our own output is what stops a field from silently changing shape.
 */
function respond(args: {
  slug: string;
  anonToken: string;
  expiresAt: Date;
  deduped: boolean;
}): PublishOutcome {
  return {
    ok: true,
    status: 201,
    body: publishResponseSchema.parse({
      live_url: liveUrl(args.slug),
      claim_url: claimUrl(args.anonToken),
      slug: args.slug,
      anonToken: args.anonToken,
      expires_in: `${DRAFT_TTL_DAYS}d`,
      expires_at: args.expiresAt.toISOString(),
      deduped: args.deduped,
    } satisfies PublishResponse),
  };
}
