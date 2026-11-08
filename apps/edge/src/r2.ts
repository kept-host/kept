// @kept/edge — the one R2 read in the request budget.
//
// Turns a validated `live` manifest plus a request path into an R2 key, fetches
// the object, and hands the caller a streamable body plus the two headers a
// browser must be able to trust: `Content-Type` and `ETag`.
//
// BUDGET: exactly one `KEPT_R2.get` per cold request. No `head` + `get` pair, no
// `list`, no retry. A conditional request that matches is still one operation —
// it just transfers no body. An SPA's deep route (E08 D12) is rewritten BEFORE
// the read, so it is one read too. The only second reads are misses: an
// extensionless miss on a non-SPA site probes `{path}/index.html` (Q-new-6), and
// a miss on a site that shipped a `404.html` reads it (D13). A `storeError` takes
// neither — a second read during an outage only doubles the load.
//
// TRUST: every byte in R2 was uploaded by a stranger. Nothing in this module
// takes a decision from the object's own metadata (see `CONTENT_TYPES`) and
// nothing concatenates a request path into a key before the guard has run.

import {
  README_OBJECT,
  SITE_FILE_TYPES,
  type KvManifest,
  type Region,
  type SiteFileType,
} from "@kept/shared";

import { injectsBadge } from "./badge";

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

/** The custom not-found page a site may ship at its root (E08 D13). */
const CUSTOM_404_DOCUMENT = "404.html";

/**
 * Extension → `Content-Type`: the shared `SITE_FILE_TYPES` table itself, so the
 * extensions publish accepts and the types the Worker serves cannot drift (D8).
 * Widened to a string index only so a request's extension can look it up.
 *
 * NEVER derived from user input and NEVER from `object.httpMetadata`: R2 returns
 * whatever content type the uploader set, and E04's uploader takes arbitrary
 * user HTML. A publisher-chosen content type is a stored-XSS vector against the
 * serving origin, so the type is decided from the extension of a key *we*
 * constructed. Task 006's `X-Content-Type-Options: nosniff` is the other half of
 * this defence — without it the browser is free to sniff past our answer.
 */
export const CONTENT_TYPES: Readonly<Record<string, SiteFileType>> = SITE_FILE_TYPES;

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
 * threw and the page may well exist. Only a `notFound` goes on to the
 * directory probe and the site's own `404.html` (see `fetchPage`).
 *
 * This field exists because collapsing every throw into a bare `missing` is what
 * let a `TypeError` from a quoted `If-None-Match` masquerade as "page deleted"
 * on every conditional request, invisibly. A `storeError` is logged; a
 * `notFound` is not.
 */
export type MissingReason = "notFound" | "storeError";

/**
 * One R2 read's outcome, for a path the guard has already accepted. `etag` is
 * the quoted ETag to answer with — R2's own, or the composite one when a badge
 * is injected (see `fetchObject`).
 */
export type ObjectFetch =
  | { kind: "object"; object: R2ObjectBody; contentType: string; etag: string }
  | { kind: "notModified"; etag: string }
  | { kind: "missing"; reason: MissingReason };

/**
 * What a request path turned into. `spaRewrite` marks a response produced by
 * D12's rewrite, which `index.ts` caches short (Q-new-1); `directory` is the
 * Q-new-6 redirect to the trailing-slash form; `custom404` is the site's own
 * `404.html` (D13).
 */
export type PageFetch =
  | { kind: "object"; object: R2ObjectBody; contentType: string; etag: string; spaRewrite: boolean }
  | { kind: "notModified"; etag: string; spaRewrite: boolean }
  | { kind: "directory"; location: string }
  | { kind: "custom404"; object: R2ObjectBody; contentType: string }
  | { kind: "missing"; reason: MissingReason }
  | { kind: "rejected" };

const REJECTED_PATH: PathResolution = { kind: "rejected" };
const REJECTED: PageFetch = { kind: "rejected" };
const NOT_FOUND = { kind: "missing", reason: "notFound" } as const;
const STORE_ERROR = { kind: "missing", reason: "storeError" } as const;

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
 * fetch — see `readObject`.
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
 * Narrow a parsed conditional to the badged representation (E10 Risk 1).
 *
 * A badged response's ETag is `"{r2etag}-{badgeHash}"`: R2's etag alone does not
 * change when only the badge does, so answering with it would let a 304 pin a
 * stale badge in a browser for good. Only an etag ending in the CURRENT badge's
 * suffix can match; it is passed down with the suffix stripped. Any other etag —
 * R2's bare one from before the badge, or one carrying an older badge's hash —
 * is dropped, so the request becomes unconditional and gets a full 200.
 */
function scopeToBadge(conditional: Conditional, suffix: string): Conditional {
  if (conditional.kind !== "etags") return conditional;
  const etags = conditional.etags
    .filter((etag) => etag.length > suffix.length && etag.endsWith(suffix))
    .map((etag) => etag.slice(0, -suffix.length));
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
 * True when a resolved path's last segment has no `.` — a route like
 * `dashboard/settings` rather than a file like `app.js`. A resolved path never
 * ends in `/` (`resolvePath` appends `index.html`), so `/about/` is not a route.
 */
function isRoute(path: string): boolean {
  return !path.slice(path.lastIndexOf("/") + 1).includes(".");
}

/**
 * Fetch what a `live` manifest serves at `pathname`.
 *
 * The guard runs first: a rejected path returns before any concatenation and
 * before any store call, so it never reaches `KEPT_R2.get` (nor D12's rewrite),
 * and the offending path is never echoed back to the caller.
 *
 * Then exactly one read, of the resolved path — or, for an SPA's route, of the
 * root `index.html` (D12). Only a `notFound` reads again:
 *
 * - a non-SPA route probes `{path}/index.html` and, if it exists, answers
 *   `directory` so the caller can 301 to `{path}/` (Q-new-6);
 * - otherwise a site whose manifest says `has404` reads its `404.html` (D13).
 *
 * A `storeError` at any step ends the walk: it is an outage, already logged,
 * and another read would only double the load.
 */
export async function fetchPage(
  bucket: R2Bucket,
  manifest: KvManifest,
  pathname: string,
  ifNoneMatch: string | undefined,
  badgeHash: string | undefined,
): Promise<PageFetch> {
  const resolved = resolvePath(pathname);
  if (resolved.kind === "rejected") return REJECTED;

  const route = isRoute(resolved.path);
  const spaRewrite = manifest.spa === true && route;
  const fetched = await fetchObject(
    bucket,
    manifest,
    spaRewrite ? INDEX_DOCUMENT : resolved.path,
    ifNoneMatch,
    badgeHash,
  );
  if (fetched.kind !== "missing") return { ...fetched, spaRewrite };
  if (fetched.reason === "storeError") return fetched;

  // An SPA never gets here for a route: its route already read `index.html`.
  if (route && manifest.spa !== true) {
    const directory = await fetchObject(
      bucket,
      manifest,
      `${resolved.path}/${INDEX_DOCUMENT}`,
      undefined,
      undefined,
    );
    if (directory.kind === "object") {
      // Existence was the question; the body is not served from here.
      await directory.object.body.cancel().catch(() => {});
      // Leading slashes collapse to one, so `//host/x` can never become a
      // protocol-relative `Location` pointing off this site.
      return { kind: "directory", location: `${pathname.replace(/^\/+/, "/")}/` };
    }
    if (directory.kind === "missing" && directory.reason === "storeError") {
      return directory;
    }
  }

  if (manifest.has404 === true) {
    const custom = await fetchObject(bucket, manifest, CUSTOM_404_DOCUMENT, undefined, undefined);
    if (custom.kind === "object") {
      return { kind: "custom404", object: custom.object, contentType: custom.contentType };
    }
  }

  return NOT_FOUND;
}

/**
 * The README page of a kept page (E10 D6): one R2 read of
 * `sites/{siteId}/_kept/readme.html`, conditional like any page. Its bytes are
 * kept's own (rendered by the control plane), so no badge suffix applies.
 */
export function fetchReadme(
  bucket: R2Bucket,
  manifest: KvManifest,
  ifNoneMatch: string | undefined,
): Promise<ObjectFetch> {
  return readObject(
    bucket,
    manifest.region,
    `sites/${manifest.siteId}/${README_OBJECT}`,
    contentTypeFor(README_OBJECT),
    ifNoneMatch,
    undefined,
  );
}

/**
 * Fetch the object at `path` of the manifest's version — a path `resolvePath`
 * accepted, or one of this module's own constants. Never a raw request path.
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
function fetchObject(
  bucket: R2Bucket,
  manifest: KvManifest,
  path: string,
  ifNoneMatch: string | undefined,
  badgeHash: string | undefined,
): Promise<ObjectFetch> {
  const contentType = contentTypeFor(path);
  return readObject(
    bucket,
    manifest.region,
    `sites/${manifest.siteId}/${manifest.versionId}/${path}`,
    contentType,
    ifNoneMatch,
    // Only an HTML response is rewritten, so only it carries the composite ETag.
    badgeHash !== undefined && injectsBadge(contentType) ? `-${badgeHash}` : undefined,
  );
}

/**
 * The single R2 read behind `fetchObject` and `fetchReadme`. `etagSuffix` is
 * set when the response will carry a badge: the ETag answered becomes
 * `"{r2etag}{suffix}"` and the conditional is narrowed by `scopeToBadge`.
 */
async function readObject(
  bucket: R2Bucket,
  region: Region,
  key: string,
  contentType: string,
  ifNoneMatch: string | undefined,
  etagSuffix: string | undefined,
): Promise<ObjectFetch> {
  const parsed =
    ifNoneMatch === undefined ? NO_CONDITION : parseIfNoneMatch(ifNoneMatch);
  const conditional =
    etagSuffix === undefined ? parsed : scopeToBadge(parsed, etagSuffix);
  const etagOf = (object: R2Object) =>
    etagSuffix === undefined ? object.httpEtag : `"${object.etag}${etagSuffix}"`;

  // The single-etag form — what a browser revalidating a page actually sends —
  // is pushed into `onlyIf`, so a match costs no body transfer. A list or `*`
  // cannot go down there (see `parseIfNoneMatch`) and is settled below instead.
  const pushedDown =
    conditional.kind === "etags" && conditional.etags.length === 1
      ? conditional.etags[0]
      : undefined;

  let object: R2ObjectBody | R2Object | null;
  try {
    object = await selectBucket(bucket, region).get(
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
    return { kind: "notModified", etag: etagOf(object) };
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
    return { kind: "notModified", etag: etagOf(object) };
  }

  return { kind: "object", object, contentType, etag: etagOf(object) };
}

/** Content type from the extension of the key we constructed — see `CONTENT_TYPES`. */
function contentTypeFor(path: string): string {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return FALLBACK_CONTENT_TYPE;
  const extension = filename.slice(dot + 1).toLowerCase();
  // Own keys only: `constructor` or `__proto__` must not reach the prototype.
  const type = Object.hasOwn(CONTENT_TYPES, extension) ? CONTENT_TYPES[extension] : undefined;
  return type?.contentType ?? FALLBACK_CONTENT_TYPE;
}
