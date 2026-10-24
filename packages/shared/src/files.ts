// @kept/shared — the file-set contract (E08, D7–D10).
//
// A version is a set of files at `sites/{siteId}/{versionId}/{path}` (D1). This
// module is the one place that says which files a set may hold (D8), what a
// valid path is (D7), which leading bytes betray a file's real type (D9), and
// how a set is hashed (D10). The publish-time reader (`apps/web`) and the
// Worker's `Content-Type` table (`apps/edge`) both read `SITE_FILE_TYPES`, so
// what is accepted and how it is served cannot drift.
//
// ⚠️ DATA AND PURE FUNCTIONS ONLY. The barrel is bundled into the Worker: no
// `node:*`, no `Buffer`, no DOM types, no zod refinement that reads bytes, and
// no module-level work beyond literals (every top-level call is
// `/*#__PURE__*/`-annotated, as ./plans explains). The user-facing copy for
// these rules needs `formatBytes` and lives in `apps/web`, beside the reader.

import { toHex, utf8, webGlobals } from "./web-globals";

// ─── D9: leading-byte signatures ───────────────────────────────────────────

/** Leading bytes to match; `null` matches any byte (WebP's RIFF size, ISO-BMFF's box size). */
export type ByteSignature = readonly (number | null)[];

/**
 * Image types and the signatures their bytes must start with (D9). A file
 * whose extension names one of these but whose bytes match none of its
 * signatures is `invalid_file`. `svg` is text and has no entry.
 *
 * AVIF is matched on the ISO-BMFF `ftyp` box at offset 4 with an `avif` (still)
 * or `avis` (sequence) major brand — what libavif and every browser encoder
 * write.
 */
export const IMAGE_SIGNATURES = {
  png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  jpeg: [[0xff, 0xd8, 0xff]],
  gif: [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], // GIF87a
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // GIF89a
  ],
  webp: [[0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50]],
  avif: [
    [null, null, null, null, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], // ftyp avif
    [null, null, null, null, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x73], // ftyp avis
  ],
  ico: [[0x00, 0x00, 0x01, 0x00]],
  bmp: [[0x42, 0x4d]],
} as const satisfies Record<string, readonly ByteSignature[]>;

export type ImageMagic = keyof typeof IMAGE_SIGNATURES;

/**
 * Executable and installer formats no file of a set may start with (D9), in
 * any non-text type → `file_type_not_allowed`. A `payload.png` that is a PE
 * file, linked with `download`, is the case this exists for.
 */
export const EXECUTABLE_SIGNATURES = [
  [0x4d, 0x5a], // PE / DOS `MZ`
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O 32-bit, big-endian
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O 64-bit, big-endian
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32-bit, little-endian
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64-bit, little-endian
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal (fat)
  [0xd0, 0xcf, 0x11, 0xe0], // CFB: MSI and legacy Office
  [0x23, 0x21], // `#!` shell script
] as const satisfies readonly ByteSignature[];

/** True when `bytes` begins with `sig` (`null` positions match anything). */
export function startsWithSignature(bytes: Uint8Array, sig: ByteSignature): boolean {
  if (bytes.length < sig.length) return false;
  return sig.every((expected, i) => expected === null || bytes[i] === expected);
}

// ─── D8: the extension allowlist ───────────────────────────────────────────

/** What kept knows about one allowed extension. */
export interface SiteFileType {
  /** The `Content-Type` the Worker serves it with — never the uploader's. */
  readonly contentType: string;
  /**
   * UTF-8 text: may travel as `encoding: "utf8"` in the JSON file list, and is
   * exempt from the executable check. Every other type must be base64.
   */
  readonly text: boolean;
  /** Image types only: the signature family its bytes must start with (D9). */
  readonly magic?: ImageMagic;
}

/**
 * Lowercase extension → type, for exactly D8's list. Anything absent is
 * `file_type_not_allowed` at publish and `application/octet-stream` at serve.
 *
 * The 14 types the Worker served before E08 keep their exact strings (`ico` is
 * `image/x-icon`, `svg` carries no charset) so a single-file page's response
 * headers are byte-identical to `dev-v0.8.0`. Every other text type carries
 * `; charset=utf-8`.
 */
export const SITE_FILE_TYPES = /*#__PURE__*/ Object.freeze({
  html: { contentType: "text/html; charset=utf-8", text: true },
  htm: { contentType: "text/html; charset=utf-8", text: true },
  css: { contentType: "text/css; charset=utf-8", text: true },
  js: { contentType: "text/javascript; charset=utf-8", text: true },
  mjs: { contentType: "text/javascript; charset=utf-8", text: true },
  cjs: { contentType: "text/javascript; charset=utf-8", text: true },
  json: { contentType: "application/json; charset=utf-8", text: true },
  map: { contentType: "application/json; charset=utf-8", text: true },
  txt: { contentType: "text/plain; charset=utf-8", text: true },
  md: { contentType: "text/markdown; charset=utf-8", text: true },
  csv: { contentType: "text/csv; charset=utf-8", text: true },
  xml: { contentType: "application/xml; charset=utf-8", text: true },
  webmanifest: { contentType: "application/manifest+json; charset=utf-8", text: true },
  svg: { contentType: "image/svg+xml", text: true },
  png: { contentType: "image/png", text: false, magic: "png" },
  jpg: { contentType: "image/jpeg", text: false, magic: "jpeg" },
  jpeg: { contentType: "image/jpeg", text: false, magic: "jpeg" },
  gif: { contentType: "image/gif", text: false, magic: "gif" },
  webp: { contentType: "image/webp", text: false, magic: "webp" },
  avif: { contentType: "image/avif", text: false, magic: "avif" },
  ico: { contentType: "image/x-icon", text: false, magic: "ico" },
  bmp: { contentType: "image/bmp", text: false, magic: "bmp" },
  woff: { contentType: "font/woff", text: false },
  woff2: { contentType: "font/woff2", text: false },
  ttf: { contentType: "font/ttf", text: false },
  otf: { contentType: "font/otf", text: false },
  glb: { contentType: "model/gltf-binary", text: false },
  gltf: { contentType: "model/gltf+json; charset=utf-8", text: true },
  bin: { contentType: "application/octet-stream", text: false },
  obj: { contentType: "model/obj; charset=utf-8", text: true },
  mtl: { contentType: "model/mtl; charset=utf-8", text: true },
  hdr: { contentType: "image/vnd.radiance", text: false },
  ktx2: { contentType: "image/ktx2", text: false },
  wasm: { contentType: "application/wasm", text: false },
  mp3: { contentType: "audio/mpeg", text: false },
  wav: { contentType: "audio/wav", text: false },
  ogg: { contentType: "audio/ogg", text: false },
  oga: { contentType: "audio/ogg", text: false },
  m4a: { contentType: "audio/mp4", text: false },
  mp4: { contentType: "video/mp4", text: false },
  webm: { contentType: "video/webm", text: false },
} as const satisfies Record<string, SiteFileType>);

export type SiteFileExtension = keyof typeof SITE_FILE_TYPES;

// ─── D7: names and paths ───────────────────────────────────────────────────

/**
 * OS junk dropped silently while normalising (D7) and listed back as
 * `ignored`. `__MACOSX/` is a folder (anything under it goes); the rest are
 * file names matched at any depth.
 */
export const SITE_JUNK_NAMES = ["__MACOSX/", ".DS_Store", "Thumbs.db", "desktop.ini"] as const;

/** Root folder reserved for kept's own files (E10's README page). */
export const SITE_RESERVED_PREFIX = "_kept/" as const;

/** Longest path, in UTF-8 bytes. */
export const SITE_PATH_MAX_BYTES = 512 as const;

/** Most `/`-separated segments a path may have. */
export const SITE_PATH_MAX_SEGMENTS = 16 as const;

/** The entry point every set must have at its root. */
export const SITE_INDEX = "index.html" as const;

/** A root file of this name is served, with status 404, for missing paths (D13). */
export const SITE_404 = "404.html" as const;

// ─── D4: the inline body ───────────────────────────────────────────────────

/**
 * The most bytes one inline publish or replace request may carry **on the
 * wire**, whatever its form (JSON with base64, multipart files, a multipart
 * zip) and whatever the caller's plan — Arun's decision of 2026-10-22
 * (Q-new-2), which replaces D4's "the free `siteBytes`".
 *
 * It equals Next's default `middlewareClientMaxBodySize`: the middleware
 * matcher covers `/api/*`, and Next hands a handler a TRUNCATED body past that
 * buffer, so a bigger inline cap would need a bigger buffer per in-flight
 * request on Railway. The reader refuses on `Content-Length` before parsing,
 * and stream-counts when it is absent. A set between this and the plan's
 * `siteBytes` goes through the presigned upload (signed-in callers only).
 */
export const INLINE_BODY_MAX_BYTES = 10 * 1024 * 1024;

/** C0 controls and DEL. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * One path against D7's per-path rules, after NFC normalisation: ≤ 512 UTF-8
 * bytes, ≤ 16 segments, no empty / `.` / `..` segment (so no trailing or doubled
 * `/`), no leading `/`, no C0/DEL control, no backslash, and nothing under
 * `_kept/` (matched ignoring case, so `_Kept/` cannot shadow kept's own file on
 * a case-insensitive export). Returns the NORMALISED path — store that one.
 *
 * Paths stay case-sensitive. Two paths equal ignoring case is a property of
 * the set, not of one path, so the reader checks it.
 */
export function validateSitePath(path: string): { ok: true; path: string } | { ok: false } {
  const normalised = path.normalize("NFC");
  if (
    normalised === "" ||
    normalised.startsWith("/") ||
    normalised.includes("\\") ||
    CONTROL_CHARACTERS.test(normalised) ||
    utf8(normalised).length > SITE_PATH_MAX_BYTES ||
    normalised.toLowerCase().startsWith(SITE_RESERVED_PREFIX)
  ) {
    return { ok: false };
  }
  const segments = normalised.split("/");
  if (
    segments.length > SITE_PATH_MAX_SEGMENTS ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return { ok: false };
  }
  return { ok: true, path: normalised };
}

// ─── D10: hashing ──────────────────────────────────────────────────────────

/** SHA-256 of some bytes, lowercase hex. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  return toHex(await webGlobals.crypto.subtle.digest("SHA-256", bytes));
}

/**
 * The content hash of a set (D10) — what `sites.content_hash` and
 * `site_versions.content_hash` store and the dedup probe matches.
 *
 * One file → that file's own SHA-256, which is exactly `hashContent(html)` for
 * a single-HTML page, so dedup and E07's scan reuse keep matching across the
 * epic. More → SHA-256 of the lines `"{path}\t{sha256}\n"`, sorted by path in
 * code-unit order, so the order files arrived in never changes the hash.
 */
export async function hashFileSet(
  entries: readonly { readonly path: string; readonly sha256: string }[],
): Promise<string> {
  if (entries.length === 0) throw new Error("hashFileSet: a file set is never empty");
  if (entries.length === 1) return entries[0]!.sha256;
  const lines = [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ path, sha256 }) => `${path}\t${sha256}\n`)
    .join("");
  return hashBytes(utf8(lines));
}
