/**
 * THE KEYED PAGE SERVICE (E09 D8): publish, replace, list, get and delete for
 * a resolved API key. `/api/v1/*` (task 008) and the MCP keyed tools (009)
 * are thin adapters over these functions; neither re-implements a rule.
 *
 * A keyed page belongs to the key's owner from its first byte, on the owner's
 * plan (Q15): it lands KEPT while a slot is free and an owned DRAFT at the cap
 * (D-03) — the studio's `publishOwnedSite`, called, not copied, so the cap,
 * dedup, provenance, store ordering and the E07 scan are exactly the studio's.
 * There is no claim link.
 *
 * ── ERRORS ───────────────────────────────────────────────────────────────────
 * The flat `{ error, message, retry_after_seconds? }` body with
 * `KEYED_ERROR_CODES` (Q10). A file-set refusal passes through untouched (it is
 * already flat); a studio refusal is flattened by `fromStudio`.
 *
 * ⚠️ A SLUG THE CALLER DOES NOT OWN IS `not_found`, never "forbidden" (D17):
 * every lookup is owner-scoped in SQL, so another account's page and a slug
 * that names nothing are the same answer.
 */
import {
  KEYED_ERROR_CODES,
  KEYED_LIST_PAGE_SIZE,
  keyedDeleteResponseSchema,
  keyedErrorSchema,
  keyedListResponseSchema,
  keyedPageSchema,
  keyedPublishResponseSchema,
  slugSchema,
  type KeyedDeleteResponse,
  type KeyedError,
  type KeyedErrorCode,
  type KeyedListResponse,
  type KeyedPage,
  type KeyedPublishResponse,
  type UploadResponse,
} from "@kept/shared";
import { z } from "zod";

import {
  getKeyedPageBySlug,
  listKeyedPages,
  type KeyedPageCursor,
  type KeyedPageRow,
} from "../db/queries/dashboard";
import { isFailure, type FileSet } from "../publish/fileset/types";
import { liveUrl, type PublisherContext, type PublishFailure, type PublishSource } from "../publish/pipeline";
import { siteHref } from "../sites/display";
import { SITE_NOT_FOUND_MESSAGE } from "../sites/keep";
import {
  deleteOwnedSite,
  publishOwnedSite,
  replaceOwnedSite,
  requestOwnedUpload,
  type StudioFailure,
} from "../sites/owner-routes";
import { appOrigin } from "../storage/env";

import { checkKeyLimit, type KeyCaller } from "./keys";

export type KeyedFailure = { ok: false; status: number; body: KeyedError };
export type KeyedOutcome<T> = { ok: true; status: 200 | 201; body: T } | KeyedFailure;

const KEYED_CODES: ReadonlySet<string> = new Set(KEYED_ERROR_CODES);

function refuse(status: number, error: KeyedErrorCode, message: string, retryAfter?: number): KeyedFailure {
  return {
    ok: false,
    status,
    body: keyedErrorSchema.parse({ error, message, retry_after_seconds: retryAfter }),
  };
}

/**
 * A studio refusal in the flat keyed body, at the studio's status. Every code
 * a keyed path can reach is in `KEYED_ERROR_CODES`; the studio-only ones (a
 * rename's, a keep's) cannot arrive here and would read as `invalid_request`.
 */
function fromStudio(failure: StudioFailure): KeyedFailure {
  const { code, message } = failure.body.error;
  return refuse(failure.status, KEYED_CODES.has(code) ? (code as KeyedErrorCode) : "invalid_request", message);
}

/** A file-set refusal is already flat; it keeps its own code (`page_too_large`, `empty_page`). */
function fromSet(failure: PublishFailure): KeyedFailure {
  return { ok: false, status: failure.status, body: failure.body };
}

const notFound = (): KeyedFailure => refuse(404, "not_found", SITE_NOT_FOUND_MESSAGE);

/** The per-key hourly bucket (D6) — publish and replace only. */
async function keyLimited(caller: KeyCaller): Promise<KeyedFailure | null> {
  const limit = await checkKeyLimit(caller.keyId);
  if (limit.allowed) return null;
  return refuse(
    429,
    "rate_limited",
    `This API key has published too often this hour. Try again in ${limit.retryAfterSeconds} seconds.`,
    limit.retryAfterSeconds,
  );
}

function studioUrl(siteId: string): string {
  return `${appOrigin()}${siteHref(siteId)}`;
}

function publishResponse(page: { id: string; slug: string; expiresAt: Date | string | null }): KeyedPublishResponse {
  const expiresAt = page.expiresAt === null ? null : new Date(page.expiresAt).toISOString();
  return keyedPublishResponseSchema.parse({
    live_url: liveUrl(page.slug),
    studio_url: studioUrl(page.id),
    slug: page.slug,
    kept: expiresAt === null,
    expires_at: expiresAt,
  });
}

function pageResponse(row: KeyedPageRow): KeyedPage {
  return keyedPageSchema.parse({
    ...publishResponse(row),
    title: row.title,
    model: row.model,
    tool: row.tool,
    prompt: row.prompt,
    readme: row.readme,
    source_url: row.sourceUrl,
    remix_of: row.remixOf,
    file_count: row.fileCount,
    updated_at: row.updatedAt.toISOString(),
  });
}

/** The caller's live-or-flagged page by slug; a malformed slug names nothing. */
async function ownedPage(caller: KeyCaller, rawSlug: string): Promise<KeyedPageRow | null> {
  const slug = slugSchema.safeParse(rawSlug);
  return slug.success ? getKeyedPageBySlug(caller.profileId, slug.data) : null;
}

/**
 * Publish a page into the key owner's account: 201 for a new page, 200 when
 * the account already serves these exact bytes (the studio's dedup). Kept if a
 * slot is free, else a draft with `expires_at` — never a 4xx for being full.
 */
export async function keyedPublish(
  caller: KeyCaller,
  set: FileSet | PublishFailure,
  publisher: PublisherContext,
  source: PublishSource,
): Promise<KeyedOutcome<KeyedPublishResponse>> {
  if (isFailure(set)) return fromSet(set);
  const limited = await keyLimited(caller);
  if (limited) return limited;

  const outcome = await publishOwnedSite(set, caller.profileId, publisher, source);
  if (!outcome.ok) return fromStudio(outcome);
  return { ok: true, status: outcome.status, body: publishResponse(outcome.body.site) };
}

/** New bytes at the same URL; the clock and the kept-ness are untouched. */
export async function keyedReplace(
  caller: KeyCaller,
  slug: string,
  set: FileSet | PublishFailure,
  source: PublishSource,
): Promise<KeyedOutcome<KeyedPublishResponse>> {
  const page = await ownedPage(caller, slug);
  if (!page) return notFound();
  if (isFailure(set)) return fromSet(set);
  const limited = await keyLimited(caller);
  if (limited) return limited;

  const outcome = await replaceOwnedSite(page.id, set, caller.profileId, source);
  if (!outcome.ok) return fromStudio(outcome);
  return { ok: true, status: 200, body: publishResponse(page) };
}

export async function keyedGet(caller: KeyCaller, slug: string): Promise<KeyedOutcome<KeyedPage>> {
  const page = await ownedPage(caller, slug);
  return page ? { ok: true, status: 200, body: pageResponse(page) } : notFound();
}

/** Take the page offline and archive it — the studio's delete (D14), download window and all. */
export async function keyedDelete(caller: KeyCaller, slug: string): Promise<KeyedOutcome<KeyedDeleteResponse>> {
  const page = await ownedPage(caller, slug);
  if (!page) return notFound();

  const outcome = await deleteOwnedSite(page.id, caller.profileId);
  if (!outcome.ok) return fromStudio(outcome);
  return { ok: true, status: 200, body: keyedDeleteResponseSchema.parse({ slug: page.slug, deleted: true }) };
}

/** The opaque `?cursor=`: base64url of `{ at, id }` — the last row's exact `(updated_at, id)`. */
const cursorSchema = z.object({ at: z.string().min(1).max(64), id: z.string().uuid() });

function encodeCursor(row: KeyedPageRow): string {
  return Buffer.from(JSON.stringify({ at: row.cursorAt, id: row.id })).toString("base64url");
}

function decodeCursor(raw: string): KeyedPageCursor | null {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed.success && !Number.isNaN(Date.parse(parsed.data.at)) ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The owner's pages, newest first, `KEYED_LIST_PAGE_SIZE` at a time. */
export async function keyedList(
  caller: KeyCaller,
  cursor?: string | null,
): Promise<KeyedOutcome<KeyedListResponse>> {
  let after: KeyedPageCursor | null = null;
  if (cursor) {
    after = decodeCursor(cursor);
    if (!after) return refuse(400, "invalid_request", "That cursor is not one this API returned. Pass `next_cursor` back as it came.");
  }

  // One extra row says whether another page follows without a second query.
  const rows = await listKeyedPages(caller.profileId, after, KEYED_LIST_PAGE_SIZE + 1);
  const pageRows = rows.slice(0, KEYED_LIST_PAGE_SIZE);
  const last = pageRows.at(-1);
  return {
    ok: true,
    status: 200,
    body: keyedListResponseSchema.parse({
      pages: pageRows.map(pageResponse),
      next_cursor: rows.length > KEYED_LIST_PAGE_SIZE && last ? encodeCursor(last) : null,
    }),
  };
}

/**
 * A presigned PUT for a large zip (E08 D5, Q5) — the studio's `createUpload`,
 * the same per-profile hourly bucket, on the owner's plan.
 */
export async function keyedUpload(caller: KeyCaller, raw: unknown): Promise<KeyedOutcome<UploadResponse>> {
  const outcome = await requestOwnedUpload(raw, caller.profileId, caller.plan);
  return outcome.ok ? outcome : fromStudio(outcome);
}
