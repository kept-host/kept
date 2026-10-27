// @kept/shared — the anonymous publish contract (E04).
//
// Request, response and error shapes for `POST /api/publish`, plus the token and
// hash helpers that endpoint needs. It lives here, next to the KV manifest
// contract, because E09's MCP server wraps the endpoint without modifying it: an
// untyped JSON blob drifts the first time either side changes.
//
// Everything in this file is isomorphic. `@kept/shared` is bundled into the
// Worker, so no `node:crypto`, no Node-only or DOM-only global — Web Crypto only.

import { z } from "zod";

import { hashBytes } from "./files";
import { provenanceShape } from "./provenance";
import { pageHtmlSchema, slugSchema } from "./schemas";
import { utf8, webGlobals } from "./web-globals";

/** Bytes of the anonymous bearer token. */
const ANON_TOKEN_BYTES = 32;

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded base64url of a byte array. Hand-rolled so no `btoa` global is needed. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64URL_ALPHABET[b0 >> 2]!;
    out += BASE64URL_ALPHABET[((b0 & 0b11) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 === undefined) break;
    out += BASE64URL_ALPHABET[((b1 & 0b1111) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 === undefined) break;
    out += BASE64URL_ALPHABET[b2 & 0b111111]!;
  }
  return out;
}

function sha256Hex(input: string): Promise<string> {
  return hashBytes(utf8(input));
}

/**
 * A fresh anonymous bearer token: 32 random bytes, base64url, CSPRNG.
 *
 * This single string grants replace and delete on a page with no other
 * authentication. It exists only in the claim/manage URL handed to the
 * publisher — it is never persisted (see `hashToken`) and never logged.
 */
export function generateAnonToken(): string {
  const bytes = webGlobals.crypto.getRandomValues(
    new Uint8Array(ANON_TOKEN_BYTES),
  );
  return base64UrlEncode(bytes);
}

/**
 * SHA-256 of an anon token, hex. What `sites.anon_token_hash` stores.
 *
 * Every lookup is an equality match on a digest, so there is no raw-token
 * comparison anywhere in the product and no constant-time helper to write.
 */
export function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}

/**
 * SHA-256 of a page's HTML, hex. What `sites.content_hash` and
 * `site_versions.content_hash` store, and what the dedup probe matches on.
 *
 * Digests the UTF-8 encoding of the string — the exact bytes uploaded to R2 —
 * so the recorded hash always describes the stored object and never a
 * re-encoding of it. A one-file set hashes to the same value (D10:
 * `hashFileSet` of one entry is that entry's `hashBytes`).
 */
export function hashContent(html: string): Promise<string> {
  return hashBytes(utf8(html));
}

/**
 * Salted SHA-256 of the publisher's client IP and user agent, hex.
 *
 * Feeds the dedup probe (unexpired anonymous draft, same content hash, same
 * publisher) and E07's rate limiter. Salted and hashed because storing visitor
 * IPs on a free-hosting product is a liability with no upside; the raw IP is
 * never returned and never logged. Rotating `PUBLISHER_HASH_SALT` invalidates
 * prior dedup matches, which is accepted.
 */
export function hashPublisher(
  ip: string,
  ua: string,
  salt: string,
): Promise<string> {
  return sha256Hex(`${salt}\n${ip}\n${ua}`);
}

/** The optional fields every publish envelope carries alongside its content. */
const publishOptionsShape = {
  /** Present only when the caller is the web UI; keyless API callers omit it and are governed by rate limits (E07). */
  turnstileToken: z.string().optional(),
  /** Optional address for the pre-expiry reminder (E05's cron). */
  reminderEmail: z.string().email().optional(),
  /** Optional provenance (E09 D10) — `title`, `model`, `tool`, `prompt`, `readme`, `source_url`, `remix_of`. */
  ...provenanceShape,
};

/**
 * Opt in to the SPA fallback (D12): an extensionless path serves the root `index.html`. Absent = false.
 * A path ending in `/` is not rewritten: `/notes/7/` reads `notes/7/index.html` and 404s without it.
 */
const spaField = z.boolean().optional();

/**
 * The single-HTML envelope — the `POST /api/publish` body before E08, plus
 * E09's optional provenance.
 *
 * **No `slug`.** The PRD rules a custom slug out at publish — "Slug: unique
 * readable ... auto"; choosing one is the rename path E06 owns. The
 * slug-bearing `publishPayloadSchema` in ./schemas is a different, unused-here
 * shape; see the note on it. Unknown keys are stripped, never refused.
 */
export const htmlPublishRequestSchema = z.object({
  /** Raw HTML for a one-page site. Same validation as `publishPayloadSchema.html`. */
  html: pageHtmlSchema,
  ...publishOptionsShape,
});

export type HtmlPublishRequest = z.infer<typeof htmlPublishRequestSchema>;

/**
 * The file-list envelope — **the agent contract** (E08 PRD §6.3, consumed by
 * E09's MCP tools, which map onto exactly this shape):
 *
 * ```jsonc
 * POST /api/publish
 * { "files": [
 *     { "path": "index.html", "content": "<!doctype html>…" },
 *     { "path": "assets/app.js", "content": "…" },
 *     { "path": "assets/logo.png", "content": "iVBORw0…", "encoding": "base64" }
 *   ],
 *   "spa": false }
 * → 201 { live_url, claim_url, slug, anonToken, expires_in, expires_at, deduped }
 * ```
 *
 * - `path` is the file's path relative to the site root, `/`-separated; the set
 *   needs an `index.html` at its root (`missing_index`). Path rules are
 *   `validateSitePath` (./files).
 * - `encoding` is `"utf8"` (the default) or `"base64"`. **base64 is required for
 *   every type `SITE_FILE_TYPES` marks `text: false`** — images, fonts, models,
 *   audio, video, wasm.
 * - Every inline body — JSON, multipart or zip — is capped at
 *   `INLINE_BODY_MAX_BYTES` (10 MB) **on the wire** (./files), so base64
 *   content tops out near 7.5 MB decoded. A larger set, up to the plan's
 *   `siteBytes`, needs a signed-in caller and the presigned path:
 *   `POST /api/uploads`, PUT the zip, then publish `{ upload_id }`.
 * - The same set may be sent as multipart instead, one `files` part per file
 *   whose **filename is the relative path** —
 *   `form.append("files", file, "assets/app.js")`; a browser keeps only the
 *   basename unless the third argument is given — or as one `archive` part
 *   holding a `.zip`.
 * - `spa: true` opts in to the SPA fallback (D12). Only an extensionless path
 *   with no trailing slash is rewritten to the root `index.html`: `/notes/7`
 *   is, but `/notes/7/` reads `notes/7/index.html` and 404s unless that file
 *   exists, so an SPA's routes must not end in `/`.
 * - Link to a folder's page as `/about/`, not `/about`. Without `spa`, the
 *   Worker answers `/about` with a 301 to `/about/` when `about/index.html`
 *   exists (Q-new-6), which costs the visitor a redirect and an extra read.
 * - The response is `publishResponseSchema`, unchanged; failures are
 *   `publishErrorSchema` with a `PUBLISH_ERROR_CODES` code.
 *
 * This schema checks only the JSON envelope. Sizes, counts, paths, types and
 * leading bytes are the reader's job (`apps/web`), so the codes stay specific.
 */
export const filesPublishRequestSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string(),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).optional(),
      }),
    )
    .min(1),
  spa: spaField,
  ...publishOptionsShape,
});

export type FilesPublishRequest = z.infer<typeof filesPublishRequestSchema>;

/**
 * The presigned-upload envelope (D5): publish a zip already PUT to the URL
 * `POST /api/uploads` returned. Signed-in callers only; an ID that is not the
 * caller's own, expired or already used is `upload_not_found`.
 */
export const uploadPublishRequestSchema = z.object({
  upload_id: z.string().uuid(),
  spa: spaField,
  ...publishOptionsShape,
});

export type UploadPublishRequest = z.infer<typeof uploadPublishRequestSchema>;

/**
 * Every JSON publish body: exactly one of `html`, `files` or `upload_id`. Each
 * branch refuses the other two keys, so a mixed body is `invalid_request`
 * rather than silently publishing whichever branch matched first.
 */
export const publishRequestSchema = z.union([
  htmlPublishRequestSchema.extend({ files: z.undefined(), upload_id: z.undefined() }),
  filesPublishRequestSchema.extend({ html: z.undefined(), upload_id: z.undefined() }),
  uploadPublishRequestSchema.extend({ html: z.undefined(), files: z.undefined() }),
]);

export type PublishRequest = z.infer<typeof publishRequestSchema>;

/** `POST /api/uploads` (D5): the size of the zip the caller is about to PUT. */
export const uploadRequestSchema = z.object({
  size_bytes: z.number().int().positive(),
});

export type UploadRequest = z.infer<typeof uploadRequestSchema>;

/**
 * The `Content-Type` the presigned PUT is signed with. The PUT must send exactly
 * this header and a `Content-Length` of exactly the declared `size_bytes`, or R2
 * refuses it (both are signed).
 */
export const UPLOAD_CONTENT_TYPE = "application/zip";

/** `POST /api/uploads`'s answer: a presigned PUT, its ID for the publish, its expiry and the signed size ceiling. */
export const uploadResponseSchema = z.object({
  upload_id: z.string().uuid(),
  upload_url: z.string().url(),
  expires_at: z.string().datetime(),
  max_bytes: z.number().int().positive(),
});

export type UploadResponse = z.infer<typeof uploadResponseSchema>;

/**
 * The `201` response body. Field names are the PRD's wire contract verbatim —
 * the snake/camel mix is intentional and must not be tidied, because agents and
 * E09 parse these exact keys.
 */
export const publishResponseSchema = z.object({
  /** `https://{slug}.kept.host` */
  live_url: z.string().url(),
  /** `https://kept.host/keep/{anonToken}` — the human-facing keep page. */
  claim_url: z.string().url(),
  slug: slugSchema,
  /** The raw bearer token. Returned once, stored only as a hash. */
  anonToken: z.string().min(1),
  /** Human-readable draft window, e.g. `"7d"`. */
  expires_in: z.string(),
  /** ISO 8601 instant the draft expires. */
  expires_at: z.string().datetime(),
  /** True when a content-hash match returned an existing draft instead of minting one. */
  deduped: z.boolean(),
});

export type PublishResponse = z.infer<typeof publishResponseSchema>;

/**
 * Machine-readable failure codes. Agents are the primary caller, so an
 * unparseable error is an infinite retry loop — codes are a closed enum, never
 * free-form strings.
 */
export const PUBLISH_ERROR_CODES = [
  /** Body was not parseable, or failed schema validation for a reason below. */
  "invalid_request",
  "empty_page",
  "page_too_large",
  /** Turnstile token was present but did not verify (web client only). */
  "turnstile_failed",
  /** Rate limited (E07). Carries `retry_after_seconds`. */
  "rate_limited",
  /**
   * The operator pause switch (E09 task 011, `KEPT_PUBLISH_PAUSED`): every
   * publish, replace and upload answers 503 with this code and
   * `retry_after_seconds`; serving, deletes and keeps stay up.
   */
  "publishing_paused",
  /** Slug minting exhausted its retry bound — transient, safe to retry. */
  "slug_unavailable",
  "internal_error",
  // E08 — file sets (PRD §7.2). `page_too_large` still means an HTML file over
  // `MAX_PAGE_BYTES`; `empty_page` an empty one.
  /** No `index.html` at the set's root after normalising. */
  "missing_index",
  /** A path broke `validateSitePath`, or two paths are equal ignoring case. */
  "invalid_path",
  /** More files than the plan's `siteFiles`. */
  "too_many_files",
  /** More bytes than the plan's `siteBytes`, or an inline body over `INLINE_BODY_MAX_BYTES`. */
  "site_too_large",
  /** A non-HTML file over the plan's `fileBytes`. */
  "file_too_large",
  /** An extension outside `SITE_FILE_TYPES`, or executable leading bytes. */
  "file_type_not_allowed",
  /** A file's bytes are not what its type says (an image without its signature, bad base64). */
  "invalid_file",
  /** The zip could not be read safely: corrupt, encrypted, a symlink or a zip bomb. */
  "invalid_archive",
  /** The `upload_id` is unknown, not the caller's, expired or already used. */
  "upload_not_found",
] as const;

export const publishErrorCodeEnum = z.enum(PUBLISH_ERROR_CODES);
export type PublishErrorCode = (typeof PUBLISH_ERROR_CODES)[number];

/** The error body every non-2xx publish response carries. */
export const publishErrorSchema = z.object({
  error: publishErrorCodeEnum,
  /** Human-readable, specific, safe to show a visitor. */
  message: z.string(),
  /** Set on `rate_limited` so a caller can back off instead of hammering. */
  retry_after_seconds: z.number().int().nonnegative().optional(),
});

export type PublishError = z.infer<typeof publishErrorSchema>;
