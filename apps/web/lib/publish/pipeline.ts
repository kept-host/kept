/**
 * The anonymous publish pipeline — E04 task 005.
 *
 * The first request in the product that touches all four stores, and the reason
 * their ordering is written down in `docs/edge-purge-contract.md`:
 *
 *   request ceiling → read the file set → Turnstile → set hash → dedup probe
 *     → new-page governors → Postgres tx (site + version + file rows)
 *     → every file to R2 (`writeVersionFiles`) → writeManifest(pointer → KV
 *     → purge) → enqueueScan
 *
 * (A replace has its own store order, `storeReplacement`: rows → files → point
 * → `syncManifest` — D18, E08 D11.)
 *
 * NO HTTP IN THIS FILE. `publishPage` takes a reader for the request's file set
 * and a publisher identity and returns an outcome; `app/api/publish/route.ts` is
 * a thin boundary over it that knows about `Request`, content types and status
 * codes, and nothing else. That split is what lets the whole pipeline be
 * exercised from a test with no server running — and it is also why the API is
 * the product rather than an accident of the landing page: E09's MCP tools and
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
 * ALL OR NOTHING (E08 D11). A version's files go up eight at a time; the first
 * refusal stops the rest and deletes every key it wrote, so no version is
 * ever visible half-uploaded and no object outlives the rows that name it.
 *
 * A FAILED PURGE IS NOT A FAILED PUBLISH (contract §3). The write already
 * succeeded and the page is correct; only the edge is stale, and it is stale
 * until a retry lands. `writeManifest` logs it; this pipeline returns 201.
 */
import {
  DRAFT_GRACE_DAYS,
  DRAFT_TTL_DAYS,
  MAX_PAGE_BYTES,
  SITE_INDEX,
  generateAnonToken,
  hashPublisher,
  hashToken,
  publishResponseSchema,
  type PublishChannel,
  type PublishError,
  type BadgeData,
  type PublishResponse,
} from "@kept/shared";
import type { z } from "zod";

import {
  activatePendingVersion,
  claimDedupCandidate,
  deletePendingVersion,
  deleteSiteCascade,
  insertAnonymousDraft,
  insertPendingVersion,
  revertReplacementVersion,
  SlugUnavailableError,
  type PendingVersionInput,
  type SitePointer,
} from "../db/queries/publish";
import { badgeDataFor } from "../badge/badge-data";
import { readSiteForManifest } from "../db/queries/manifest-sync";
import { appOrigin, publisherHashSalt, servingBaseDomain } from "../storage/env";
import { pointerKey, removeManifest, syncManifest, writeManifest } from "../storage/manifest";
import { pageObjectKey, r2Store, siteObjectKey } from "../storage/r2";
import { isFailure, type FileSet } from "./fileset/types";
import {
  checkRateLimit,
  checkRequestLimit,
  enqueueScan,
  verifyTurnstile,
  type RateLimitDecision,
} from "./hooks";
import { extractPageTitle } from "./page-title";

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
  /**
   * E09 D5: a ready-made publisher key that REPLACES `hashPublisher(ip, ua)` —
   * the dedup scope and E07's buckets are keyed by it. Set by the MCP door,
   * whose callers share cloud egress IPs; never a raw IP. Absent everywhere
   * else, and then nothing changes.
   */
  publisherKey?: string;
}

/**
 * How a write arrived, beyond who sent it: the `X-Kept-Client` label (E09 D9,
 * `keptClientFrom`) for `site_versions.client`, and — for E09's doors — the
 * channel to record instead of the path's own (`api` for `/api/v1`, `mcp`).
 */
export interface PublishSource {
  client: string | null;
  publishedVia?: PublishChannel;
}

/** No label, the path's own channel — every caller that predates E09. */
export const DEFAULT_SOURCE: PublishSource = { client: null };

/**
 * `sites.publisher_hash` for this publisher: `publisherKey` when set, else the
 * salted hash of IP + UA. The raw IP goes into the digest and nowhere else.
 */
export async function publisherHashOf(publisher: PublisherContext): Promise<string> {
  return (
    publisher.publisherKey ??
    hashPublisher(publisher.ip, publisher.userAgent, publisherHashSalt())
  );
}

export type PublishOutcome =
  | { ok: true; status: 201; body: PublishResponse }
  | PublishFailure;

/**
 * The failure half, named because task 006's replace/delete/reminder return
 * different success bodies but the IDENTICAL failure shape — the error enum is
 * closed and shared, so every route in the epic fails the same way.
 */
export type PublishFailure = { ok: false; status: number; body: PublishError };

export function fail(status: number, body: PublishError): PublishFailure {
  return { ok: false, status, body };
}

/**
 * Map a schema failure onto the closed error enum. The codes are what agents
 * branch on, so "the body was 6 MB" and "the body had no `html` field" must
 * never arrive as the same code — an unparseable error is an infinite retry
 * loop.
 *
 * Exported because task 006's replace runs the SAME validation as publish and
 * must return the SAME error shapes for the same bodies; a second mapper would
 * drift the moment one of them grew a case.
 */
export function requestError(error: z.ZodError): PublishFailure {
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
      message: `The page is larger than the ${MAX_PAGE_BYTES}-byte limit for an HTML file — move its largest inline assets into their own files, or trim them, and try again.`,
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
  return { expiresAt, purgeAfter: graceEnds(expiresAt) };
}

/**
 * `from + DRAFT_GRACE_DAYS` — the ONE grace window: after a draft's clock, and
 * after an owner archives a page (D14, D16). Not a second 30-day constant.
 */
export function graceEnds(from: Date): Date {
  return new Date(from.getTime() + DRAFT_GRACE_DAYS * MS_PER_DAY);
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
 * How a publish or replace reads its file set — `readFileSet` over the request,
 * bound by the route. A reader rather than the set itself so the pipeline
 * decides WHEN the body is read: after the request ceiling (PRD §5.3 step 6),
 * so an over-limit caller costs no zip extraction.
 */
export type FileSetReader = () => Promise<FileSet | PublishFailure>;

/** Files a version uploads at once (E08 D11). */
const UPLOAD_CONCURRENCY = 8;

/** The page's display name: the `<title>` of the set's `index.html`, or `null`. */
export function setTitle(set: FileSet): string | null {
  const index = set.entries.find((entry) => entry.path === SITE_INDEX);
  return index ? extractPageTitle(new TextDecoder().decode(index.bytes)) : null;
}

/** A version's rows for `set`: one `site_versions` row, one file row per entry. */
export function pendingVersion(
  siteId: string,
  versionId: string,
  set: FileSet,
  publishedVia: PublishChannel,
  client: string | null,
): PendingVersionInput {
  return {
    siteId,
    versionId,
    r2Key: pageObjectKey(siteId, versionId),
    contentHash: set.contentHash,
    sizeBytes: set.totalBytes,
    publishedVia,
    client,
    spa: set.spa,
    has404: set.has404,
    files: set.entries.map(({ path, bytes, sha256 }) => ({ path, sizeBytes: bytes.length, sha256 })),
  };
}

function versionKeys(siteId: string, versionId: string, set: Pick<FileSet, "entries">): string[] {
  return set.entries.map((entry) => siteObjectKey(siteId, versionId, entry.path));
}

/**
 * Upload every file of a version — all or nothing (E08 D11).
 *
 * At most `UPLOAD_CONCURRENCY` puts in flight. The first refusal stops the
 * scheduling, the puts already in flight finish, and every key that was written
 * is deleted in one `deleteMany`. A failed unwind is logged loudly enough for
 * E07's audit and reported as `unwound: false`.
 *
 * Exported for AC14's drill, which feeds it a key R2 really refuses.
 */
export async function writeVersionFiles(
  siteId: string,
  versionId: string,
  set: Pick<FileSet, "entries">,
): Promise<StoreWriteResult> {
  const r2 = r2Store();
  const written: string[] = [];
  let failure: string | null = null;
  let next = 0;

  async function worker(): Promise<void> {
    while (failure === null && next < set.entries.length) {
      const index = next++;
      const entry = set.entries[index]!;
      const key = siteObjectKey(siteId, versionId, entry.path);
      try {
        await r2.put(key, entry.bytes, entry.contentType);
        written.push(key);
      } catch (err) {
        failure ??= `version ${versionId}, file ${index + 1} of ${set.entries.length}: ${message(err)}`;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, set.entries.length) }, worker),
  );
  if (failure === null) return { ok: true };

  try {
    await r2.deleteMany(written);
    return { ok: false, error: failure, unwound: true };
  } catch (err) {
    console.error(
      `[kept] ROLLBACK INCOMPLETE — version ${versionId} of site ${siteId}: ${written.length} uploaded keys could not be deleted (${message(err)}). Unreferenced bytes, not a serving fault; Postgres is the authority, never an R2 list (contract §7.5).`,
    );
    return { ok: false, error: failure, unwound: false };
  }
}

/**
 * The store half of a BRAND-NEW page: **every file → manifest**, and the exact
 * reverse on failure. The caller has committed the site, version and file rows;
 * nothing serves the slug until its manifest exists.
 *
 * The files MUST precede the manifest: the manifest is what makes a slug
 * resolvable, so publishing it before the bytes exist is a window in which the
 * Worker serves a 404 for a page the control plane calls live.
 *
 * `status: "live"` is the one literal manifest left (D18): the row was inserted
 * a moment ago and nobody else can have changed it. Everything after a page's
 * first publish goes through `syncManifest`. `spa` / `has404` are written only
 * when true; `badge` (E10 D3) always — from `badgeDataFor`, as the sync does.
 *
 * `unwound` reports whether the reverse path completed. `false` means the edge
 * and Postgres may now disagree, and the `pending_purges` row the failed write
 * left behind is what reconciles them.
 */
export async function storeNewPage(args: {
  slug: string;
  siteId: string;
  versionId: string;
  set: FileSet;
  ownerId: string | null;
}): Promise<StoreWriteResult> {
  const { slug, siteId, versionId, set, ownerId } = args;

  // The badge (E10 D3) comes from the row just committed — the same builder
  // `syncManifest` uses, so a first manifest and every later one agree. Read
  // before any store write: a failure here has nothing to unwind.
  let badge: BadgeData;
  try {
    const row = await readSiteForManifest(siteId);
    if (!row) return { ok: false, error: `site ${siteId} has no row to build a manifest from`, unwound: true };
    badge = badgeDataFor(row);
  } catch (err) {
    return { ok: false, error: `manifest read: ${message(err)}`, unwound: true };
  }

  const files = await writeVersionFiles(siteId, versionId, set);
  if (!files.ok) return files;

  const written = await writeManifest(slug, {
    siteId,
    versionId,
    // Drafts are `live`; the clock lives in Postgres and never in the manifest.
    status: "live",
    region: "auto",
    ownerId,
    updatedAt: Date.now(),
    ...(set.spa && { spa: true }),
    ...(set.has404 && { has404: true }),
    badge,
  });
  if (written.ok) {
    // `purge.ok === false` is NOT a failure (contract §3). `writeManifest` has
    // already logged it; the stores agree and the page is correct.
    return { ok: true };
  }

  // Unwind in reverse. `step: "kv"` means the POINTER IS WRITTEN and must be
  // removed; `"validate"` and `"pointer"` mean nothing reached a store.
  const unwound = await unwindStores({
    slug,
    versionId,
    keys: versionKeys(siteId, versionId, set),
    pointerWritten: written.step === "kv",
  });
  return { ok: false, error: `manifest ${written.step}: ${written.error}`, unwound };
}

/** What a replace's store half answers: the title the row ended up with. */
export type ReplaceStoreResult =
  | { ok: true; title: string | null }
  | { ok: false; error: string; unwound: boolean };

/**
 * A replace, owner and anonymous alike (E08 D11, epic Risk 2):
 *
 *   (a) INSERT the version + file rows — NOT pointed at        (commits)
 *   (b) every file to R2                                        (`writeVersionFiles`)
 *   (c) point the site at it, stamp `activated_at`              (own transaction)
 *   (d) `syncManifest`, purging old ∪ new paths                  (D18, D14)
 *
 * Until (c) the row still names the previous version, so a `syncManifest` from
 * anyone else in the upload window — a moderation flag, the expiry sweep, a
 * rename, a repurge replay — re-publishes the previous version, never a
 * half-uploaded one. A failure at (b) or (c) deletes the written keys and the
 * un-pointed rows; the pointer never moved, so nothing is reverted. A failure at
 * (d) runs `unwindReplacement`: the row back to `previous`, the edge re-synced,
 * then the new keys deleted.
 *
 * The manifest is `syncManifest`'s, read from the row under its lock, so a flag
 * that committed after the caller's status check is what the edge serves —
 * never a stale `live`.
 *
 * @throws when (a) cannot commit — nothing was written; the caller answers it.
 */
export async function storeReplacement(args: {
  slug: string;
  siteId: string;
  /**
   * NEW versionId, SAME siteId — so every key is a new object rather than a
   * mutation of one the edge may have cached, and the slug never has to move.
   */
  versionId: string;
  set: FileSet;
  /** `setTitle(set)`, re-extracted from the new bytes. */
  title: string | null;
  publishedVia: PublishChannel;
  /** `site_versions.client` for the new version (E09 D9); absent = none sent. */
  client?: string | null;
  /** The row's pointer as the caller found it — what an unwind puts back. */
  previous: SitePointer;
}): Promise<ReplaceStoreResult> {
  const { slug, siteId, versionId, set, previous } = args;
  const keys = versionKeys(siteId, versionId, set);

  await insertPendingVersion(pendingVersion(siteId, versionId, set, args.publishedVia, args.client ?? null));

  const files = await writeVersionFiles(siteId, versionId, set);
  if (!files.ok) {
    return { ok: false, error: files.error, unwound: (await dropPendingVersion(siteId, versionId)) && files.unwound };
  }

  let title: string | null;
  try {
    ({ title } = await activatePendingVersion(siteId, {
      versionId,
      title: args.title,
      contentHash: set.contentHash,
      sizeBytes: set.totalBytes,
    }, set.provenance));
  } catch (err) {
    const keysGone = await deleteKeys(keys, versionId);
    const rowsGone = await dropPendingVersion(siteId, versionId);
    return { ok: false, error: `point: ${message(err)}`, unwound: keysGone && rowsGone };
  }

  const synced = await syncManifest(siteId, { alsoPurgeVersionId: previous.versionId });
  // `purge.ok === false` is NOT a failure (contract §3); `syncManifest` only
  // fails when a store write did, and has already logged it.
  if (synced.ok) return { ok: true, title };
  const unwound = await unwindReplacement({ slug, siteId, versionId, keys, previous });
  return { ok: false, error: `manifest sync: ${synced.error}`, unwound };
}

/** The rows of a version nothing points at. True when they are gone. */
async function dropPendingVersion(siteId: string, versionId: string): Promise<boolean> {
  try {
    await deletePendingVersion(siteId, versionId);
    return true;
  } catch (err) {
    console.error(
      `[kept] ROLLBACK INCOMPLETE — un-pointed version ${versionId} of site ${siteId} kept its rows: ${message(err)}. It serves nothing; the next prune or the purge job collects it. Postgres is the authority, never an R2 list (contract §7.5).`,
    );
    return false;
  }
}

/** Delete a version's keys. True when R2 confirmed it. */
async function deleteKeys(keys: readonly string[], versionId: string): Promise<boolean> {
  try {
    await r2Store().deleteMany(keys);
    return true;
  } catch (err) {
    console.error(
      `[kept] ROLLBACK INCOMPLETE — ${keys.length} orphan R2 objects of version ${versionId}: ${message(err)}. Unreferenced bytes, not a serving fault; E07's audit reconciles against Postgres.`,
    );
    return false;
  }
}

/** The row half of a failed replace: point it back at `previous`. True when it landed. */
async function revertReplacement(args: {
  siteId: string;
  versionId: string;
  previous: SitePointer;
}): Promise<boolean> {
  try {
    await revertReplacementVersion(args);
    return true;
  } catch (err) {
    console.error(
      `[kept] ROLLBACK INCOMPLETE — site ${args.siteId} still points at version ${args.versionId}: ${message(err)}. Postgres is the authority, never an R2 list (contract §7.5).`,
    );
    return false;
  }
}

/**
 * A replace whose manifest sync failed after the pointer moved: revert the row,
 * then sync again (purging both sets) so the edge names the previous version,
 * then delete the new keys — unless the slug pointer may still name the new
 * version, because deleting bytes a pointer names takes the page dark on the
 * next KV miss. A second failed sync leaves its `pending_purges` row for the
 * repurge job.
 */
async function unwindReplacement(args: {
  slug: string;
  siteId: string;
  versionId: string;
  keys: readonly string[];
  previous: SitePointer;
}): Promise<boolean> {
  if (!(await revertReplacement(args))) return false;

  const rewound = await syncManifest(args.siteId, { alsoPurgeVersionId: args.versionId });
  if (!rewound.ok && (await pointerMayName(args.slug, args.versionId))) {
    console.error(
      `[kept] ROLLBACK INCOMPLETE — the pointer for slug "${args.slug}" may still name version ${args.versionId}; its ${args.keys.length} objects are kept until the repurge job re-syncs the row.`,
    );
    return false;
  }

  return (await deleteKeys(args.keys, args.versionId)) && rewound.ok;
}

/** Whether `slug`'s pointer may name `versionId`. Unreadable counts as yes. */
async function pointerMayName(slug: string, versionId: string): Promise<boolean> {
  try {
    const body = await r2Store().get(pointerKey(slug));
    return body !== null && (JSON.parse(body) as { versionId?: string }).versionId === versionId;
  } catch {
    return true;
  }
}

async function unwindStores(args: {
  slug: string;
  versionId: string;
  keys: readonly string[];
  pointerWritten: boolean;
}): Promise<boolean> {
  let clean = true;

  if (args.pointerWritten) {
    // `removeManifest` is the inverse of the whole sequence — pointer, then KV,
    // then purge — and is safe when the KV key was never written: a KV delete of
    // an absent key is a no-op.
    const rewound = await removeManifest(args.slug);
    if (!rewound.ok) {
      clean = false;
      console.error(
        `[kept] ROLLBACK INCOMPLETE — slug "${args.slug}" failed to unwind at the "${rewound.step}" step: ${rewound.error}. A manifest may still resolve this slug with no row behind it. E07 DIVERGENCE AUDIT: reconcile against Postgres, never against an R2 list (contract §7.5).`,
      );
    }
  }

  return (await deleteKeys(args.keys, args.versionId)) && clean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Publish a page. The whole endpoint, minus HTTP.
 *
 * @param read the request's file set (`readFileSet`, bound by the route). It
 *   runs AFTER the request ceiling, so a caller over it costs no extraction.
 * @param source the `X-Kept-Client` label and, for E09's doors, the channel.
 *
 * Provenance (E09 D10) rides on the set and is written with the new row. A
 * dedup hit writes none of it: the existing page is returned as it is.
 */
export async function publishPage(
  read: FileSetReader,
  publisher: PublisherContext,
  source: PublishSource = DEFAULT_SOURCE,
): Promise<PublishOutcome> {
  // ── 1. request ceiling ─────────────────────────────────────────────────────
  const publisherHash = await publisherHashOf(publisher);

  // The request ceiling counts every request, deduped or not — a dedup hit
  // still rotates the token. It needs only the publisher, so it runs BEFORE the
  // body is read (PRD §5.3 step 6). The new-page governors wait for the probe.
  const requests = await checkRequestLimit(publisherHash);
  if (!requests.allowed) return rateLimited(requests);

  // ── 2. read + validate (D3, D6–D10) ────────────────────────────────────────
  const set = await read();
  if (isFailure(set)) return set;
  const { turnstileToken, reminderEmail } = set;

  // ── 3. E07 seams ───────────────────────────────────────────────────────────
  // Turnstile ONLY when a token is present: keyless API callers legitimately
  // cannot solve a CAPTCHA, and publishing keyless is the epic's locked
  // decision. See `./hooks`. It needs the envelope, so it follows the read.
  if (turnstileToken !== undefined) {
    const turnstile = await verifyTurnstile(turnstileToken);
    if (!turnstile.ok) {
      return fail(403, {
        error: "turnstile_failed",
        message: `The bot check did not pass (${turnstile.reason}). Reload the page and try again.`,
      });
    }
  }

  // ── 4. content hash ────────────────────────────────────────────────────────
  // D10, over the exact bytes that will be stored — for a single HTML document
  // that is `hashContent(html)`, unchanged since E04 (AC17). The page's display
  // name comes off the same in-memory `index.html`; the helper cannot throw, so
  // extraction can never fail a publish (E06 task 001).
  const contentHash = set.contentHash;
  const title = setTitle(set);
  // The door (§5.9), on E04's existing distinction: the landing's browser path
  // is the one that carries a Turnstile token; a keyless caller never does.
  // Recorded on the version row only — the wire response does not change.
  const publishedVia = source.publishedVia ?? (turnstileToken !== undefined ? "web" : "api");

  // One token, used either to rotate the deduped row or to create a new one.
  const anonToken = generateAnonToken();
  const anonTokenHash = await hashToken(anonToken);

  // ── 5. dedup probe ─────────────────────────────────────────────────────────
  const deduped = await claimDedupCandidate({
    publisherHash,
    contentHash,
    anonTokenHash,
  });
  if (deduped) {
    // Spends nothing from `publish:<key>` — the governors count NEW pages.
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

  // ── 6. new-page governors ──────────────────────────────────────────────────
  const rate = await checkRateLimit(publisherHash);
  if (!rate.allowed) return rateLimited(rate);

  // ── 7. Postgres tx ─────────────────────────────────────────────────────────
  const siteId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const { expiresAt, purgeAfter } = draftClocks(new Date());

  let slug: string;
  try {
    ({ slug } = await insertAnonymousDraft({
      version: pendingVersion(siteId, versionId, set, publishedVia, source.client),
      title,
      provenance: set.provenance,
      anonTokenHash,
      publisherHash,
      expiresAt,
      purgeAfter,
      reminderEmail,
    }));
  } catch (err) {
    if (err instanceof SlugUnavailableError) {
      console.error(`[kept] ${err.message}`);
      return slugUnavailable();
    }
    console.error(`[kept] publish: Postgres write failed — ${message(err)}`);
    return internalError();
  }

  // ── 8–11. files → pointer → KV → purge ─────────────────────────────────────
  const stored = await storeNewPage({ slug, siteId, versionId, set, ownerId: null });

  if (!stored.ok) {
    console.error(
      `[kept] publish: store write failed for site ${siteId} (slug "${slug}", version ${versionId}, ${set.entries.length} files) — ${stored.error}`,
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
  void enqueueScan(siteId, versionId, "publish");

  return respond({ slug, anonToken, expiresAt, deduped: false });
}

/**
 * A governor refused (`./hooks`). One shape for every anonymous path — the
 * publish here and the replace in `./anon-manage` — so an agent backs off the
 * same way whichever limit it hit.
 */
export function rateLimited(
  rate: Extract<RateLimitDecision, { allowed: false }>,
): PublishFailure {
  return fail(429, {
    error: "rate_limited",
    message: `Too many requests from here (${rate.reason}). Try again in ${rate.retryAfterSeconds} seconds.`,
    retry_after_seconds: rate.retryAfterSeconds,
  });
}

/**
 * Slug minting exhausted its attempts (`SlugUnavailableError`) — a broken index
 * or CSPRNG, transient from the caller's side. Shared with the studio publish,
 * which mints through the same bound.
 */
export function slugUnavailable(): PublishFailure {
  return fail(503, {
    error: "slug_unavailable",
    message:
      "Could not assign a link for this page right now. This is transient — retry the request.",
  });
}

/** The generic 5xx. Shared with the anonymous manage routes (task 006). */
export function internalError(): PublishFailure {
  return fail(500, {
    error: "internal_error",
    message:
      "kept could not publish this page. Nothing was left half-written — retry the request.",
  });
}

/**
 * Build and VALIDATE the 201 body before it leaves. The response schema is
 * shared because E09's MCP server wraps this contract without modifying it;
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
