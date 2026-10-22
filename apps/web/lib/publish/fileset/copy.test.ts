/**
 * E08 task 003 — the §8 sentences and `printablePath`. Pure; touches no store.
 *
 * The browser-safety check reads the module's own import graph: `copy.ts` is
 * imported by the studio and the landing (tasks 010/011), so a `node:` import
 * or yauzl reaching it would break the client bundle.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { INLINE_BODY_MAX_BYTES, limitsFor } from "@kept/shared";

import {
  executableFile,
  fileTooLarge,
  fileTypeNotAllowed,
  inlineTooLarge,
  invalidArchive,
  invalidFile,
  invalidPath,
  missingIndex,
  printablePath,
  siteTooLarge,
  skipped,
  tooManyFiles,
  uploadNotFound,
} from "./copy";

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

test("printablePath: printable paths pass through unchanged", () => {
  assert.equal(printablePath("assets/index-Ab12.js"), "assets/index-Ab12.js");
  assert.equal(printablePath("bilder/größe.png"), "bilder/größe.png");
});

test("printablePath: controls, bidi overrides, zero-width and lone surrogates become ?", () => {
  assert.equal(printablePath("a\u0000b\u001fc\u007fd\u0085e"), "a?b?c?d?e");
  assert.equal(printablePath("evil‮gnp.exe"), "evil?gnp.exe");
  assert.equal(printablePath("zero​width"), "zero?width");
  assert.equal(printablePath("lone\ud800x"), "lone?x");
  assert.equal(printablePath("line break"), "line?break");
});

test("printablePath: ≤ 200 UTF-8 bytes, cut on a code-point boundary, ending in …", () => {
  const ascii = printablePath("a".repeat(500));
  assert.ok(utf8Length(ascii) <= 200, `ascii: ${utf8Length(ascii)} bytes`);
  assert.ok(ascii.endsWith("…"));

  const wide = printablePath("€".repeat(300)); // 3 bytes each
  assert.ok(utf8Length(wide) <= 200, `wide: ${utf8Length(wide)} bytes`);
  assert.ok(wide.endsWith("…"));
  assert.ok(!wide.includes("�"), "no character was split");

  const exact = "b".repeat(200);
  assert.equal(printablePath(exact), exact, "exactly 200 bytes is not cut");
});

test("the PRD §8 sentences, verbatim where the PRD fixes them", () => {
  const free = limitsFor("free");
  const pro = limitsFor("premium");
  assert.equal(
    missingIndex(),
    "There's no index.html at the top of this folder. kept opens index.html first — add one or move it up a level.",
  );
  assert.equal(
    tooManyFiles(free.siteFiles + 1, "free", free.siteFiles),
    `This site has ${free.siteFiles + 1} files. Free sites can have up to ${free.siteFiles}.`,
  );
  assert.equal(
    tooManyFiles(pro.siteFiles + 1, "premium", pro.siteFiles),
    `This site has ${(pro.siteFiles + 1).toLocaleString("en-US")} files. Pro sites can have up to ${pro.siteFiles.toLocaleString("en-US")}.`,
  );
  assert.equal(
    siteTooLarge(free.siteBytes + free.fileBytes, "free", free.siteBytes),
    "This site is 30.0 MB. Free sites can be up to 20.0 MB.",
  );
  assert.equal(
    fileTooLarge("media/clip.mp4", free.fileBytes + 1, free.fileBytes),
    "media/clip.mp4 is 10.0 MB. Files can be up to 10.0 MB.",
  );
  assert.equal(
    fileTypeNotAllowed("pdf", "docs/brochure.pdf"),
    "kept doesn't host .pdf files (docs/brochure.pdf). Remove it and try again.",
  );
  assert.equal(
    fileTypeNotAllowed("", "Makefile"),
    "kept doesn't host files without an extension (Makefile). Remove it and try again.",
  );
  assert.equal(invalidFile("logo.png", "PNG"), "logo.png isn't a valid PNG file.");
  assert.equal(invalidArchive(), "That .zip couldn't be opened. Re-create it and try again.");
  assert.equal(
    invalidPath("a\\b.css"),
    "a\\b.css has a name kept can't serve. Use letters, numbers, - _ . and /.",
  );
  assert.equal(skipped(1, [".DS_Store"]), "Published. Skipped 1 file (.DS_Store).");
  assert.equal(
    skipped(7, ["a", "b", "c", "d", "e", "f", "g"]),
    "Published. Skipped 7 files (a, b, c, d, e, …).",
  );
});

test("the Q-new-2 and D5/D9 sentences", () => {
  assert.equal(
    inlineTooLarge(INLINE_BODY_MAX_BYTES),
    "This upload is over 10.0 MB, the most one request can carry. Sign in to publish a larger site.",
  );
  assert.match(uploadNotFound(), /^That upload wasn't found\./);
  assert.equal(
    executableFile("models/ship.glb"),
    "models/ship.glb is a program, and kept doesn't host programs. Remove it and try again.",
  );
});

test("no builder echoes a raw path: every path and extension is sanitised", () => {
  const hostile = "x‮\u0000.png";
  for (const sentence of [
    fileTooLarge(hostile, 1, 1),
    fileTypeNotAllowed("p\u0000df", hostile),
    executableFile(hostile),
    invalidFile(hostile, "P\u0000NG"),
    invalidPath(hostile),
    skipped(1, [hostile]),
  ]) {
    assert.doesNotMatch(sentence, /[\u0000‮]/u, sentence);
  }
});

test("copy.ts is browser-safe: no node: import, no yauzl", () => {
  const source = readFileSync(new URL("./copy.ts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["@kept/shared", "../../plans/plan-label", "../../sites/display"]);
});
