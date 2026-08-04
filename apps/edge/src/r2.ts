// @kept/edge — the one R2 read in the request budget.
//
// Turns a validated `live` manifest plus a request path into an R2 key, fetches
// the object, and hands the caller a streamable body plus the two headers a
// browser must be able to trust: `Content-Type` and `ETag`.
//
// BUDGET: exactly one `KEPT_R2.get` per cold request. No `head` + `get` pair, no
// `list`, no retry. A conditional request that matches is still one operation —
// it just transfers no body.
//
// TRUST: every byte in R2 was uploaded by a stranger. Nothing in this module
// takes a decision from the object's own metadata (see `CONTENT_TYPES`) and
// nothing concatenates a request path into a key before the guard has run.

import type { KvManifest, Region } from "@kept/shared";

/**
 * Maximum request path length, in bytes of the raw (still percent-encoded)
 * pathname. 1024 bytes is far past any legitimate page path and well short of
 * the ~2 KB an R2 key allows, so the check can happen before decoding —
 * percent-decoding only ever shrinks a path, so the decoded form is always
 * within the same bound.
 */
export const MAX_REQUEST_PATH_BYTES = 1024;

/** The single-file v1 default; also what a directory-shaped path resolves to. */
const INDEX_DOCUMENT = "index.html";

/**
 * Extension → `Content-Type`, owned by the Worker.
 *
 * NEVER derived from user input and NEVER from `object.httpMetadata`: R2 returns
 * whatever content type the uploader set, and E04's uploader takes arbitrary
 * user HTML. A publisher-chosen content type is a stored-XSS vector against the
 * serving origin, so the type is decided from the extension of a key *we*
 * constructed. Task 006's `X-Content-Type-Options: nosniff` is the other half of
 * this defence — without it the browser is free to sniff past our answer.
 */
const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff2: "font/woff2",
};

/** Anything unmapped is served as opaque bytes rather than guessed at. */
const FALLBACK_CONTENT_TYPE = "application/octet-stream";

/**
 * NUL and the other C0/DEL control characters, which have no place in a key.
 *
 * `no-control-regex` exists to catch control characters nobody meant to write;
 * matching them deliberately is the entire point here.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** An unpaired surrogate — a JS string that is not encodable as valid UTF-8. */
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export type PathResolution =
  | { kind: "path"; path: string }
  | { kind: "rejected" };

/**
 * Why a `missing` happened. The OUTCOME is identical — `index.ts` renders the
 * branded 404 for both, and must keep doing so — but the two are not the same
 * event: `notFound` is the expected case (a manifest pointing at an object never
 * written or already purged), while `storeError` means the store call itself
 * threw and the page may well exist.
 *
 * This field exists because collapsing every throw into a bare `missing` is what
 * let a `TypeError` from a quoted `If-None-Match` masquerade as "page deleted"
 * on every conditional request, invisibly. A `storeError` is logged; a
 * `notFound` is not.
 */
export type MissingReason = "notFound" | "storeError";

export type ObjectFetch =
  | { kind: "object"; object: R2ObjectBody; contentType: string }
  | { kind: "notModified"; etag: string }
  | { kind: "missing"; reason: MissingReason }
  | { kind: "rejected" };

const REJECTED_PATH: PathResolution = { kind: "rejected" };
const REJECTED: ObjectFetch = { kind: "rejected" };
const NOT_FOUND: ObjectFetch = { kind: "missing", reason: "notFound" };
const STORE_ERROR: ObjectFetch = { kind: "missing", reason: "storeError" };

/**
 * Resolve a request pathname to the path portion of an R2 key, or reject it.
 *
 * WHY THE GUARD EXISTS BEFORE MULTI-FILE DOES: R2 keys are a flat namespace, so
 * the moment a request path is concatenated into a key without normalization,
 * `https://slug.kept.host/../../sites/{otherSiteId}/…` becomes a probe against
 * every other tenant's objects. Today this resolves to `index.html` on
 * essentially every request and the exposure is nil — which is exactly why it is
 * free to write now and expensive to remember later.
 *
 * Order matters: length, then a SINGLE decode, then the character and segment
 * checks, and only then any concatenation. A rejection is a value, never a
 * throw — a `URIError` escaping here would be a 500 on somebody's page.
 */
export function resolvePath(pathname: string): PathResolution {
  if (new TextEncoder().encode(pathname).length > MAX_REQUEST_PATH_BYTES) {
    return REJECTED_PATH;
  }

  let decoded: string;
  try {
    // Exactly once. Decoding twice would let `%252e%252e` become `..` after the
    // guard has already looked at it.
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape or an invalid UTF-8 byte sequence throws `URIError`.
    // That is a rejection, not an error page with a stack trace.
    return REJECTED_PATH;
  }

  if (CONTROL_CHARACTERS.test(decoded)) return REJECTED_PATH;
  if (LONE_SURROGATE.test(decoded)) return REJECTED_PATH;
  // Backslash is a path separator on the storage side of enough systems to be
  // worth refusing outright rather than reasoning about.
  if (decoded.includes("\\")) return REJECTED_PATH;

  const trimmed = decoded.replace(/^\/+/, "");
  if (trimmed.split("/").includes("..")) return REJECTED_PATH;

  if (trimmed === "") return { kind: "path", path: INDEX_DOCUMENT };
  if (trimmed.endsWith("/")) {
    return { kind: "path", path: `${trimmed}${INDEX_DOCUMENT}` };
  }
  return { kind: "path", path: trimmed };
}

/**
 * A parsed `If-None-Match`. `any` is the `*` form; `etags` holds BARE etags in
 * the shape `R2Object.etag` uses; `none` means there is nothing to condition on.
 */
type Conditional =
  | { kind: "none" }
  | { kind: "any" }
  | { kind: "etags"; etags: string[] };

const NO_CONDITION: Conditional = { kind: "none" };
const ANY_REPRESENTATION: Conditional = { kind: "any" };

/** `"abc"` or `W/"abc"` → `abc`. Anything else is taken verbatim. */
const ETAG_TOKEN = /^(?:W\/)?"(.*)"$/;

/**
 * Parse `If-None-Match` into what R2's `onlyIf` actually accepts.
 *
 * THIS IS NOT COSMETIC. `etagDoesNotMatch` wants the BARE etag — the value of
 * `R2Object.etag`, not `R2Object.httpEtag`. We answer with `httpEtag`, which is
 * quoted, so the browser sends those exact quoted bytes back, and workerd
 * rejects a quoted conditional with `TypeError: Conditional ETag should not be
 * quoted`. Forwarding the header raw therefore turned EVERY revalidation of a
 * cached page into a branded 404 — a permanent page looking deleted the moment a
 * visitor's browser checked on it. Unquote here, once, at the boundary.
 *
 * A weak etag (`W/"abc"`) is unwrapped and compared like a strong one: `If-None-
 * Match` is defined to use weak comparison anyway, and R2 only ever mints strong
 * etags, so the two forms are the same value with different clothing.
 *
 * A LIST (`"a", "b"`) keeps every entry. Splitting on `,` is the pragmatic
 * parse; an etag may legally contain a comma, but R2's never do (they are hex
 * digests), and a mis-split can only fail the match and re-send a full 200 — the
 * answer that is always safe.
 *
 * Neither a list nor `*` can be pushed into `onlyIf` (the type says
 * `etagDoesNotMatch` accepts an array, but workerd rejects one at runtime:
 * "the provided value is not of type 'string'"), so both are evaluated after the
 * fetch — see `fetchObject`.
 */
function parseIfNoneMatch(header: string): Conditional {
  const value = header.trim();
  if (value === "") return NO_CONDITION;
  if (value === "*") return ANY_REPRESENTATION;

  const etags: string[] = [];
  for (const part of value.split(",")) {
    const token = part.trim();
    if (token === "") continue;
    const unquoted = ETAG_TOKEN.exec(token)?.[1];
    etags.push(unquoted ?? token);
  }

  return etags.length > 0 ? { kind: "etags", etags } : NO_CONDITION;
}

/**
 * Pick the bucket a manifest's `region` points at.
 *
 * v1 writes `auto` and only `auto` is bound. E11 SEAM: `eu` selects a second,
 * EU-jurisdiction bucket (`KEPT_R2_EU`), which stays unbound until that epic —
 * `Env` has exactly two store bindings in E03 and gains no third here. Until
 * then an `eu` manifest serves from `KEPT_R2` rather than erroring: a field
 * arriving ahead of the deployed Worker must never take a page offline.
 */
function selectBucket(bucket: R2Bucket, _region: Region): R2Bucket {
  return bucket;
}

/**
 * Fetch the object a `live` manifest points at.
 *
 * The key is `sites/{siteId}/{versionId}/{path}` — keyed by `siteId`, NEVER by
 * slug. That is what makes a rename in E06 a KV-only write with no file move,
 * and it is why a traversal in `path` would cross a tenant boundary rather than
 * just 404.
 *
 * `ifNoneMatch` is parsed by `parseIfNoneMatch` — the header's quoted, weak and
 * comma-separated forms all become the bare etags R2 wants — and pushed down
 * into `onlyIf`, so a matching conditional costs no body transfer and the whole
 * thing stays one operation.
 *
 * Nothing throws out of here: every outcome, including an unexpected store
 * failure, is a value the caller can render.
 */
export async function fetchObject(
  bucket: R2Bucket,
  manifest: KvManifest,
  pathname: string,
  ifNoneMatch: string | undefined,
): Promise<ObjectFetch> {
  const resolved = resolvePath(pathname);
  if (resolved.kind === "rejected") {
    // Returns before any concatenation and before any store call: a rejected
    // path never reaches `KEPT_R2.get`, and the offending path is never echoed
    // back to the caller.
    return REJECTED;
  }

  const key = `sites/${manifest.siteId}/${manifest.versionId}/${resolved.path}`;

  const conditional =
    ifNoneMatch === undefined ? NO_CONDITION : parseIfNoneMatch(ifNoneMatch);

  // The single-etag form — what a browser revalidating a page actually sends —
  // is pushed into `onlyIf`, so a match costs no body transfer. A list or `*`
  // cannot go down there (see `parseIfNoneMatch`) and is settled below instead.
  const pushedDown =
    conditional.kind === "etags" && conditional.etags.length === 1
      ? conditional.etags[0]
      : undefined;

  let object: R2ObjectBody | R2Object | null;
  try {
    object = await selectBucket(bucket, manifest.region).get(
      key,
      pushedDown === undefined
        ? undefined
        : { onlyIf: { etagDoesNotMatch: pushedDown } },
    );
  } catch (error) {
    // A binding-level failure ends the same way as a missing object — a branded
    // page, not a 500 — but it is NOT the same event, so it is logged and
    // carries `storeError`. An unexplained throw silently rendering "nothing
    // kept here" is precisely how the quoted-`If-None-Match` bug hid.
    console.error("[edge] r2.get failed", key, error);
    return STORE_ERROR;
  }

  // A manifest pointing at a `versionId` whose object was never written, or was
  // already purged, is the common case here — not an exceptional one.
  if (object === null) return NOT_FOUND;

  // R2 answers a failed `onlyIf` precondition with a bodyless `R2Object`: the
  // client already holds this version.
  if (!("body" in object)) {
    return { kind: "notModified", etag: object.httpEtag };
  }

  // The conditionals `onlyIf` could not carry, settled here against the object
  // we already hold: `*` matches because a representation exists at all, and a
  // list matches on any member. `object.etag` is the BARE etag, which is the
  // shape `parseIfNoneMatch` produces. Still exactly one R2 operation — the cost
  // is a body we fetched and must now discard rather than leave dangling, and
  // `cancel` is never allowed to become a throw out of this function.
  if (
    pushedDown === undefined &&
    (conditional.kind === "any" ||
      (conditional.kind === "etags" && conditional.etags.includes(object.etag)))
  ) {
    await object.body.cancel().catch(() => {});
    return { kind: "notModified", etag: object.httpEtag };
  }

  return {
    kind: "object",
    object,
    contentType: contentTypeFor(resolved.path),
  };
}

/** Content type from the extension of the key we constructed — see `CONTENT_TYPES`. */
function contentTypeFor(path: string): string {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return FALLBACK_CONTENT_TYPE;
  return CONTENT_TYPES[filename.slice(dot + 1).toLowerCase()] ?? FALLBACK_CONTENT_TYPE;
}
