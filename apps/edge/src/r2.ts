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

export type ObjectFetch =
  | { kind: "object"; object: R2ObjectBody; contentType: string }
  | { kind: "notModified"; etag: string }
  | { kind: "missing" }
  | { kind: "rejected" };

const REJECTED_PATH: PathResolution = { kind: "rejected" };
const REJECTED: ObjectFetch = { kind: "rejected" };
const MISSING: ObjectFetch = { kind: "missing" };

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
 * `ifNoneMatch` is pushed down into R2's `onlyIf` so a matching conditional
 * costs no body transfer, and the whole thing stays one operation.
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

  let object: R2ObjectBody | R2Object | null;
  try {
    object = await selectBucket(bucket, manifest.region).get(
      key,
      ifNoneMatch ? { onlyIf: { etagDoesNotMatch: ifNoneMatch } } : undefined,
    );
  } catch {
    // A binding-level failure is the same answer as a missing object: a branded
    // page, not a 500.
    return MISSING;
  }

  // A manifest pointing at a `versionId` whose object was never written, or was
  // already purged, is the common case here — not an exceptional one.
  if (object === null) return MISSING;

  // R2 answers a failed `onlyIf` precondition with a bodyless `R2Object`: the
  // client already holds this version.
  if (!("body" in object)) {
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
