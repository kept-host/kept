/**
 * E08 task 001 — the file-set contract in `@kept/shared/src/files.ts`: D7's
 * path rules, D8's type table, D9's signatures and D10's set hash, plus AC17's
 * pin that a single-HTML page hashes exactly as it did at `dev-v0.8.0`.
 *
 * Lives in `apps/web` because `packages/shared` has no test runner. Real code,
 * no mocks; touches no store.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  EXECUTABLE_SIGNATURES,
  IMAGE_SIGNATURES,
  SITE_404,
  SITE_FILE_TYPES,
  SITE_INDEX,
  SITE_JUNK_NAMES,
  SITE_PATH_MAX_BYTES,
  SITE_PATH_MAX_SEGMENTS,
  SITE_RESERVED_PREFIX,
  hashBytes,
  hashContent,
  hashFileSet,
  startsWithSignature,
  validateSitePath,
  type ImageMagic,
} from "@kept/shared";

const utf8 = (text: string) => new TextEncoder().encode(text);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// ─── AC17: the single-file hash is frozen ──────────────────────────────────

/** Non-ASCII on purpose: the hash is of the UTF-8 bytes, so multi-byte characters must survive. */
const PINNED_HTML = "<!doctype html>\n<title>kept — café ✓</title>\n<p>One page, one file. 🌱</p>\n";

/** `hashContent(PINNED_HTML)` computed on `develop` at `dev-v0.8.0`, before E08 touched `publish.ts`. */
const PINNED_HASH = "5c005c88c8eab03225411aa438e789d0d095f866b6f3b9125e08ffb773aa40ad";

test("AC17: hashContent of the fixture is the value it produced at dev-v0.8.0", async () => {
  assert.equal(await hashContent(PINNED_HTML), PINNED_HASH);
  assert.equal(sha256(utf8(PINNED_HTML)), PINNED_HASH, "and it is plain SHA-256 of the UTF-8 bytes");
});

test("AC17 / D10: a one-file set hashes to the SHA-256 of its bytes — hashContent's value", async () => {
  const bytes = utf8(PINNED_HTML);
  const entry = { path: SITE_INDEX, sha256: await hashBytes(bytes) };
  assert.equal(entry.sha256, PINNED_HASH);
  assert.equal(await hashFileSet([entry]), await hashContent(PINNED_HTML));
});

// ─── D10: the set hash ─────────────────────────────────────────────────────

test("D10: a multi-file hash is SHA-256 of sorted `path\\tsha256\\n` lines, whatever the order", async () => {
  const files = [
    { path: "index.html", sha256: sha256(utf8("<p>hi</p>")) },
    { path: "assets/app.js", sha256: sha256(utf8("console.log(1)")) },
    { path: "Zebra.css", sha256: sha256(utf8("p{}")) },
  ];
  // Code-unit order: uppercase before lowercase, `assets/…` before `index.html`.
  const expected = sha256(
    utf8(files
      .map((f) => f.path)
      .sort()
      .map((path) => `${path}\t${files.find((f) => f.path === path)!.sha256}\n`)
      .join("")),
  );
  assert.equal(await hashFileSet(files), expected);
  assert.equal(await hashFileSet([...files].reverse()), expected, "order-independent");
  assert.equal(await hashFileSet([files[2]!, files[0]!, files[1]!]), expected, "order-independent");

  const renamed = files.map((f) => (f.path === "Zebra.css" ? { ...f, path: "zebra.css" } : f));
  assert.notEqual(await hashFileSet(renamed), expected, "a path is part of the hash");
});

test("D10: an empty set is a bug, not a hash", async () => {
  await assert.rejects(hashFileSet([]));
});

// ─── D7: paths ─────────────────────────────────────────────────────────────

test("D7: validateSitePath accepts ordinary, nested, unicode and .well-known paths", () => {
  for (const path of [
    "index.html",
    "assets/app.js",
    "a/b/c/d.png",
    ".well-known/security.txt",
    "fonts/Inter-Bold.woff2",
    "über/straße.html",
    "x".repeat(SITE_PATH_MAX_BYTES),
    Array(SITE_PATH_MAX_SEGMENTS).fill("d").join("/"),
    "kept/x.html", // only `_kept/` is reserved
    "_keptish/x.html",
  ]) {
    const result = validateSitePath(path);
    assert.ok(result.ok, `accepted: ${path.slice(0, 60)}`);
    assert.equal(result.path, path.normalize("NFC"));
  }
});

test("D7: validateSitePath refuses each rule's violation", () => {
  const refused: [string, string][] = [
    ["empty", ""],
    ["leading slash", "/index.html"],
    ["trailing slash (empty segment)", "assets/"],
    ["doubled slash", "assets//app.js"],
    ["dot segment", "./index.html"],
    ["dot-dot segment", "assets/../index.html"],
    ["bare dot-dot", ".."],
    ["backslash", "assets\\app.js"],
    ["NUL", "index\u0000.html"],
    ["tab", "a\tb.html"],
    ["newline", "a\nb.html"],
    ["DEL", "a\u007fb.html"],
    ["513 bytes", "x".repeat(SITE_PATH_MAX_BYTES + 1)],
    ["513 bytes of multi-byte characters", "é".repeat(256) + "x"],
    ["17 segments", Array(SITE_PATH_MAX_SEGMENTS + 1).fill("d").join("/")],
    ["reserved prefix", `${SITE_RESERVED_PREFIX}readme.html`],
    ["reserved prefix, other case", "_Kept/readme.html"],
  ];
  for (const [label, path] of refused) {
    assert.deepEqual(validateSitePath(path), { ok: false }, label);
  }
});

test("D7: validateSitePath NFC-normalises, so NFD and NFC input yield the same path", () => {
  const nfd = "café/menu.html";
  const nfc = "café/menu.html";
  assert.notEqual(nfd, nfc);
  const fromNfd = validateSitePath(nfd);
  const fromNfc = validateSitePath(nfc);
  assert.ok(fromNfd.ok && fromNfc.ok);
  assert.equal(fromNfd.path, nfc);
  assert.equal(fromNfc.path, nfc);
});

test("D7: the byte limit counts UTF-8 bytes, not characters", () => {
  // 256 × 2-byte `é` = 512 bytes: at the limit. One more ASCII byte is over.
  assert.ok(validateSitePath("é".repeat(256)).ok);
  assert.equal(validateSitePath("é".repeat(256) + "x").ok, false);
});

test("D7: the named constants", () => {
  assert.deepEqual([...SITE_JUNK_NAMES], ["__MACOSX/", ".DS_Store", "Thumbs.db", "desktop.ini"]);
  assert.equal(SITE_RESERVED_PREFIX, "_kept/");
  assert.equal(SITE_INDEX, "index.html");
  assert.equal(SITE_404, "404.html");
});

// ─── D8: the type table ────────────────────────────────────────────────────

const D8_EXTENSIONS =
  "html htm css js mjs cjs json map txt md csv xml webmanifest svg png jpg jpeg gif webp avif ico bmp woff woff2 ttf otf glb gltf bin obj mtl hdr ktx2 wasm mp3 wav ogg oga m4a mp4 webm".split(
    " ",
  );

/** What the Worker served before E08 (`apps/edge/src/r2.ts`) — must stay byte-identical (AC23). */
const PRE_E08_CONTENT_TYPES: Record<string, string> = {
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

test("D8: SITE_FILE_TYPES is exactly D8's list, frozen", () => {
  assert.deepEqual(Object.keys(SITE_FILE_TYPES).sort(), [...D8_EXTENSIONS].sort());
  assert.ok(Object.isFrozen(SITE_FILE_TYPES));
  for (const excluded of ["pdf", "zip", "exe", "dmg", "docx", "sh", "php", "htaccess"]) {
    assert.equal(excluded in SITE_FILE_TYPES, false, `${excluded} is not allowed`);
  }
});

test("D8: every key is lowercase with a content type; text types carry charset=utf-8", () => {
  for (const [ext, type] of Object.entries(SITE_FILE_TYPES)) {
    assert.equal(ext, ext.toLowerCase(), `${ext} is lowercase`);
    assert.match(type.contentType, /^[a-z]+\/[a-z0-9.+-]+(; charset=utf-8)?$/, `${ext}: ${type.contentType}`);
    // `svg` is text (agents send it inline) but keeps the Worker's exact pre-E08
    // string, which carries no charset.
    if (type.text && ext !== "svg") {
      assert.ok(type.contentType.endsWith("; charset=utf-8"), `${ext} is text: ${type.contentType}`);
    }
    if (!type.text) assert.equal(type.contentType.includes("charset"), false, `${ext} is binary`);
  }
});

test("D8 / AC23: the 14 pre-E08 types keep their exact strings", () => {
  for (const [ext, contentType] of Object.entries(PRE_E08_CONTENT_TYPES)) {
    assert.equal(SITE_FILE_TYPES[ext as keyof typeof SITE_FILE_TYPES].contentType, contentType, ext);
  }
  assert.equal(SITE_FILE_TYPES.mjs.contentType, "text/javascript; charset=utf-8");
  assert.equal(SITE_FILE_TYPES.cjs.contentType, "text/javascript; charset=utf-8");
  assert.equal(SITE_FILE_TYPES.wasm.contentType, "application/wasm");
});

test("D8 / D9: exactly the image types name a signature family, and each family exists", () => {
  const withMagic = Object.entries(SITE_FILE_TYPES)
    .filter(([, type]) => "magic" in type)
    .map(([ext]) => ext)
    .sort();
  assert.deepEqual(withMagic, ["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "webp"]);
  for (const ext of withMagic) {
    const type = SITE_FILE_TYPES[ext as keyof typeof SITE_FILE_TYPES] as { magic: ImageMagic; text: boolean };
    assert.ok(type.magic in IMAGE_SIGNATURES, `${ext} → ${type.magic}`);
    assert.equal(type.text, false);
  }
});

// ─── D9: signatures ────────────────────────────────────────────────────────

const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** Real leading bytes of each image format, as encoders write them. */
const REAL_HEADERS: Record<ImageMagic, Uint8Array[]> = {
  png: [bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, ...ascii("IHDR"))],
  jpeg: [
    bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF")), // JFIF
    bytes(0xff, 0xd8, 0xff, 0xe1, 0x00, 0x18, ...ascii("Exif")), // EXIF
  ],
  gif: [bytes(...ascii("GIF87a"), 0x01, 0x00), bytes(...ascii("GIF89a"), 0x01, 0x00)],
  webp: [bytes(...ascii("RIFF"), 0x24, 0x00, 0x00, 0x00, ...ascii("WEBPVP8 "))],
  avif: [
    bytes(0x00, 0x00, 0x00, 0x20, ...ascii("ftypavif"), 0x00, 0x00, 0x00, 0x00, ...ascii("avifmif1")),
    bytes(0x00, 0x00, 0x00, 0x1c, ...ascii("ftypavis"), 0x00, 0x00, 0x00, 0x00),
  ],
  ico: [bytes(0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10)],
  bmp: [bytes(...ascii("BM"), 0x36, 0x00, 0x0c, 0x00)],
};

const matchesFamily = (data: Uint8Array, magic: ImageMagic) =>
  IMAGE_SIGNATURES[magic].some((sig) => startsWithSignature(data, sig));

test("D9: each real image header matches its own family and no other", () => {
  for (const [magic, headers] of Object.entries(REAL_HEADERS) as [ImageMagic, Uint8Array[]][]) {
    for (const header of headers) {
      assert.ok(matchesFamily(header, magic), `${magic} header matches ${magic}`);
      for (const other of Object.keys(IMAGE_SIGNATURES) as ImageMagic[]) {
        if (other !== magic) assert.equal(matchesFamily(header, other), false, `${magic} header vs ${other}`);
      }
      assert.equal(
        EXECUTABLE_SIGNATURES.some((sig) => startsWithSignature(header, sig)),
        false,
        `${magic} header is not an executable`,
      );
    }
  }
});

test("D9: a RIFF that is not WebP, and an ISO-BMFF that is not AVIF, are refused", () => {
  assert.equal(matchesFamily(bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")), "webp"), false);
  assert.equal(matchesFamily(bytes(0, 0, 0, 0x20, ...ascii("ftypisom")), "avif"), false);
});

test("D9: executable stubs are caught — PE, ELF, Mach-O, fat, CFB, shebang", () => {
  const stubs: [string, Uint8Array][] = [
    ["PE", bytes(...ascii("MZ"), 0x90, 0x00, 0x03, 0x00)],
    ["ELF", bytes(0x7f, ...ascii("ELF"), 0x02, 0x01, 0x01)],
    ["Mach-O 64 LE", bytes(0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01)],
    ["Mach-O 32 LE", bytes(0xce, 0xfa, 0xed, 0xfe)],
    ["Mach-O 32 BE", bytes(0xfe, 0xed, 0xfa, 0xce)],
    ["Mach-O 64 BE", bytes(0xfe, 0xed, 0xfa, 0xcf)],
    ["Mach-O fat", bytes(0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02)],
    ["MSI / CFB", bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)],
    ["shebang", utf8("#!/bin/sh\nrm -rf /\n")],
  ];
  for (const [label, stub] of stubs) {
    assert.ok(EXECUTABLE_SIGNATURES.some((sig) => startsWithSignature(stub, sig)), label);
  }
});

test("D9: startsWithSignature handles short input and wildcards", () => {
  assert.equal(startsWithSignature(bytes(0x89, 0x50), IMAGE_SIGNATURES.png[0]), false, "shorter than the signature");
  assert.equal(startsWithSignature(bytes(), [0x4d, 0x5a]), false, "empty input");
  assert.equal(startsWithSignature(bytes(1, 2, 3), []), true, "the empty signature matches anything");
  assert.equal(startsWithSignature(bytes(9, 0x41), [null, 0x41]), true, "null is a wildcard");
});
