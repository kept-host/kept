/**
 * E08 task 010 — the browser packer (`pack.ts`), shared with task 011.
 *
 * Real `File`s and the real `client-zip`; the packed zip is read back by the
 * server's own zip reader (`readZipStream`, task 003), so "the studio packs
 * what the server can read" is proven end to end, not asserted about a byte
 * layout. Pure otherwise: no store, no request.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { INLINE_BODY_MAX_BYTES } from "@kept/shared";

import { inlineTooLarge, missingIndex, NOT_A_PAGE } from "./fileset/copy";
import { readZipStream } from "./fileset/zip";
import { isFailure } from "./fileset/types";
import {
  archiveForm,
  collectInput,
  fitsInline,
  inlineArchiveForm,
  isRefusal,
  packEntries,
  setBytes,
  toIntent,
  type PackEntry,
} from "./pack";

const html = (title: string) => `<!doctype html><title>${title}</title><h1>${title}</h1>`;
const file = (name: string, body: string | Uint8Array<ArrayBuffer>, type = "") =>
  new File([body], name, { type, lastModified: 1_700_000_000_000 });
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** A Vite-shaped `dist/`: index.html, hashed JS and CSS, an image. */
function viteDist(): PackEntry[] {
  return [
    { path: "dist/index.html", file: file("index.html", html("vite"), "text/html") },
    { path: "dist/assets/index-Bx1a2b3c.js", file: file("index-Bx1a2b3c.js", "console.log('vite')") },
    { path: "dist/assets/index-D4e5f6g7.css", file: file("index-D4e5f6g7.css", "h1{color:red}") },
    { path: "dist/vite.png", file: file("vite.png", PNG) },
  ];
}

test("pack.ts is browser-only: no node: import, nothing that reaches a store", () => {
  const source = readFileSync(new URL("./pack.ts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  console.log("[pack] imports:", imports.join(", "));
  assert.deepEqual(
    imports.filter((path) => path!.startsWith("node:") || /storage|\/db|yauzl|fileset\/(read|zip)/.test(path!)),
    [],
  );
});

test("collectInput keeps a webkitdirectory file's relative path, and a plain pick's name", () => {
  const chosen = file("app.js", "1");
  Object.defineProperty(chosen, "webkitRelativePath", { value: "dist/assets/app.js" });
  const plain = file("index.html", html("plain"));
  const entries = collectInput([chosen, plain]);
  console.log("[pack] collectInput:", entries.map((entry) => entry.path));
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ["dist/assets/app.js", "index.html"],
  );
});

test("toIntent: one page → html, one .zip → zip (sent as-is), several → files labelled by their folder", () => {
  const page = toIntent([{ path: "game.html", file: file("game.html", html("g"), "text/html") }]);
  assert.ok(!isRefusal(page) && page.kind === "html" && page.label === "game.html");

  const zip = toIntent([{ path: "site.ZIP", file: file("site.ZIP", PNG) }]);
  assert.ok(!isRefusal(zip) && zip.kind === "zip" && zip.label === "site.ZIP");

  const folder = toIntent(viteDist());
  assert.ok(!isRefusal(folder) && folder.kind === "files");
  assert.equal(folder.label, "dist");
  assert.equal(folder.entries.length, 4);

  const loose = toIntent([
    { path: "index.html", file: file("index.html", html("l")) },
    { path: "app.js", file: file("app.js", "1") },
  ]);
  assert.ok(!isRefusal(loose) && loose.kind === "files" && loose.label === "2 files");
  console.log("[pack] labels:", { page: page.label, zip: zip.label, folder: folder.label, loose: loose.label });
});

test("toIntent refuses before any request: an empty drop, and one file that is neither a page nor a zip", () => {
  const empty = toIntent([]);
  assert.ok(isRefusal(empty));
  assert.equal(empty.error, "missing_index");
  assert.equal(empty.message, missingIndex());

  const png = toIntent([{ path: "photo.png", file: file("photo.png", PNG, "image/png") }]);
  assert.ok(isRefusal(png));
  assert.equal(png.message, NOT_A_PAGE);
  console.log("[pack] refusals:", empty.error, "/", png.message);
});

test("packEntries: one store-only zip the server's reader reads back path for path, byte for byte", async () => {
  const entries = viteDist();
  const progress: number[] = [];
  const zip = await packEntries(entries, (packed, total) => {
    assert.equal(total, entries.length);
    progress.push(packed);
  });
  console.log(`[pack] ${entries.length} files → ${zip.size} B zip; progress ${progress.join(",")}`);
  assert.deepEqual(progress, [1, 2, 3, 4]);

  // Store-only: every local file header says method 0 (stored), never 8 (deflate).
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const methods: number[] = [];
  for (let offset = 0; offset + 30 <= bytes.length; offset += 1) {
    if (view.getUint32(offset, true) === 0x04034b50) methods.push(view.getUint16(offset + 8, true));
  }
  assert.equal(methods.length, entries.length);
  assert.ok(methods.every((method) => method === 0), `methods ${methods.join(",")}`);
  // Stored, so the zip is the set plus headers — never smaller.
  assert.ok(zip.size > setBytes(entries));

  const read = await readZipStream(zip.stream(), "free");
  assert.ok(!isFailure(read), JSON.stringify(read));
  const byPath = new Map(read.map((raw) => [raw.path, raw.bytes]));
  for (const { path, file: source } of entries) {
    const got = byPath.get(path);
    assert.ok(got, `${path} is in the zip`);
    assert.deepEqual(Buffer.from(got), Buffer.from(await source.arrayBuffer()), path);
  }
});

test("fitsInline: up to INLINE_BODY_MAX_BYTES less the multipart envelope goes inline; past it, presigned", () => {
  assert.equal(fitsInline(1), true);
  assert.equal(fitsInline(INLINE_BODY_MAX_BYTES - 64 * 1024), true);
  assert.equal(fitsInline(INLINE_BODY_MAX_BYTES), false);
  assert.equal(fitsInline(INLINE_BODY_MAX_BYTES + 1), false);
});

test("archiveForm: one `archive` part named *.zip, and `spa` only when it is on", () => {
  const zip = new Blob([PNG]);
  const on = archiveForm(zip, true);
  const part = on.get("archive");
  assert.ok(part instanceof File && part.name.endsWith(".zip"));
  assert.equal(on.get("spa"), "true");
  assert.equal(archiveForm(zip, false).get("spa"), null);
});

test("inlineArchiveForm (011, anonymous): a zip passes as it is, a set is packed after its count is told, and anything over the inline ceiling is refused with the server's sentence before packing", async () => {
  const zip = file("site.zip", PNG, "application/zip");
  const passed = await inlineArchiveForm({ kind: "zip", file: zip, label: zip.name });
  assert.ok(passed instanceof FormData);
  assert.equal(((passed as FormData).get("archive") as File).size, zip.size);
  assert.equal((passed as FormData).get("spa"), null);

  const told: number[] = [];
  const entries = viteDist();
  const packed = await inlineArchiveForm({ kind: "files", entries, label: "dist" }, (n) => told.push(n));
  console.log("[pack] inlineArchiveForm packing told:", told);
  assert.deepEqual(told, [entries.length]);
  assert.ok(packed instanceof FormData);
  assert.ok(((packed as FormData).get("archive") as File).size >= setBytes(entries));

  const refusal = { error: "site_too_large", message: inlineTooLarge(INLINE_BODY_MAX_BYTES) };
  const bigZip = file("big.zip", new Uint8Array(INLINE_BODY_MAX_BYTES), "application/zip");
  assert.deepEqual(await inlineArchiveForm({ kind: "zip", file: bigZip, label: bigZip.name }), refusal);

  const bigSet = [...entries, { path: "dist/big.png", file: file("big.png", new Uint8Array(INLINE_BODY_MAX_BYTES)) }];
  const untold: number[] = [];
  assert.deepEqual(
    await inlineArchiveForm({ kind: "files", entries: bigSet, label: "dist" }, (n) => untold.push(n)),
    refusal,
  );
  assert.deepEqual(untold, [], "an oversize set is refused before it is packed");
  console.log("[pack] inlineArchiveForm refusal:", refusal.message);
});
