/**
 * E08 task 003 — caps (AC8), types (AC10) and leading bytes (AC11). Every
 * number comes from `limitsFor(plan)` / `MAX_PAGE_BYTES`; the fixtures are
 * generated here. Pure; touches no store.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_PAGE_BYTES, SITE_FILE_TYPES, limitsFor, type Plan } from "@kept/shared";

import type { PublishFailure } from "../pipeline";
import { checkSet, extensionOf, siteFileType, type TypedFile } from "./checks";
import { isFailure, type RawFile } from "./types";

const enc = new TextEncoder();
const INDEX: RawFile = { path: "index.html", bytes: enc.encode("<!doctype html><title>t</title>") };
const zeros = (path: string, size: number): RawFile => ({ path, bytes: new Uint8Array(size) });
const bytesOf = (path: string, ...bytes: number[]): RawFile => ({
  path,
  bytes: Uint8Array.from([...bytes, ...new Array<number>(64).fill(0)]),
});

/** A real 1×1 PNG. */
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);
/** A real 1×1 GIF89a. */
const GIF = Uint8Array.from(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
/** A PE stub: `MZ`, then padding. */
const PE = [0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00];

function ok(result: TypedFile[] | PublishFailure): TypedFile[] {
  if (isFailure(result)) assert.fail(`expected a pass, got ${JSON.stringify(result.body)}`);
  return result;
}

function refused(result: TypedFile[] | PublishFailure, code: string, status: number): string {
  if (!isFailure(result)) assert.fail(`expected ${code}, got a pass`);
  assert.equal(result.body.error, code, result.body.message);
  assert.equal(result.status, status);
  return result.body.message;
}

test("AC8: free — one file over siteFiles is too_many_files; Pro takes the same set", () => {
  const { siteFiles } = limitsFor("free");
  const set = [INDEX, ...Array.from({ length: siteFiles }, (_, i) => zeros(`f/${i}.bin`, 1))];
  const message = refused(checkSet(set, "free"), "too_many_files", 413);
  assert.equal(message, `This site has ${siteFiles + 1} files. Free sites can have up to ${siteFiles}.`);
  assert.equal(ok(checkSet(set, "premium")).length, siteFiles + 1);
});

test("AC8: free — siteBytes + 1 in total is site_too_large; Pro takes the same set", () => {
  const { siteBytes, fileBytes } = limitsFor("free");
  const set: RawFile[] = [INDEX];
  let left = siteBytes + 1 - INDEX.bytes.length;
  for (let i = 0; left > 0; i++) {
    const size = Math.min(fileBytes, left);
    set.push(zeros(`blob${i}.bin`, size));
    left -= size;
  }
  assert.equal(set.reduce((n, f) => n + f.bytes.length, 0), siteBytes + 1);
  assert.match(refused(checkSet(set, "free"), "site_too_large", 413), /Free sites can be up to 20\.0 MB\.$/);
  ok(checkSet(set, "premium"));
});

test("AC8: free — one file of fileBytes + 1 is file_too_large naming it; Pro takes it", () => {
  const { fileBytes } = limitsFor("free");
  const set = [INDEX, zeros("media/big.bin", fileBytes + 1)];
  assert.match(refused(checkSet(set, "free"), "file_too_large", 413), /^media\/big\.bin is /);
  ok(checkSet(set, "premium"));
});

test("AC8: an HTML file over MAX_PAGE_BYTES is page_too_large on every plan", () => {
  for (const plan of ["free", "premium"] satisfies Plan[]) {
    const set = [INDEX, zeros("docs/huge.html", MAX_PAGE_BYTES + 1)];
    assert.match(refused(checkSet(set, plan), "page_too_large", 413), /^docs\/huge\.html is /);
    ok(checkSet([INDEX, zeros("docs/fits.html", MAX_PAGE_BYTES)], plan));
  }
});

test("AC10: .pdf, a nested .zip, .exe, an unlisted extension and no extension → file_type_not_allowed", () => {
  for (const [path, ext] of [
    ["docs/brochure.pdf", "pdf"],
    ["bundle.zip", "zip"],
    ["setup.exe", "exe"],
    ["data.xyz", "xyz"],
    ["Makefile", ""],
    ["proto.constructor", "constructor"],
  ] as const) {
    const message = refused(checkSet([INDEX, zeros(path, 4)], "free"), "file_type_not_allowed", 400);
    assert.ok(message.includes(`(${path})`), `names the path: ${message}`);
    if (ext !== "") assert.ok(message.includes(`.${ext} files`), message);
  }
});

test("AC10: the lookup is by lowercase extension", () => {
  const typed = ok(checkSet([INDEX, { path: "LOGO.PNG", bytes: PNG }], "free"));
  assert.equal(typed[1]!.contentType, "image/png");
  assert.equal(extensionOf("a/b.tar.GZ"), "gz");
  assert.equal(extensionOf(".htaccess"), "");
  assert.equal(extensionOf("dir.d/file"), "");
  assert.equal(siteFileType("__proto__"), undefined);
  assert.equal(siteFileType("toString"), undefined);
});

test("AC11: a PE stub renamed .png is invalid_file; a real PNG passes", () => {
  const message = refused(checkSet([INDEX, bytesOf("payload.png", ...PE)], "free"), "invalid_file", 400);
  assert.equal(message, "payload.png isn't a valid PNG file.");
  ok(checkSet([INDEX, { path: "logo.png", bytes: PNG }], "free"));
});

test("AC11: a PE stub renamed .glb is file_type_not_allowed", () => {
  const message = refused(checkSet([INDEX, bytesOf("ship.glb", ...PE)], "free"), "file_type_not_allowed", 400);
  assert.match(message, /^ship\.glb is a program/);
});

test("D9: ELF, Mach-O, CFB and #! are refused in every non-text, non-image type", () => {
  const signatures = [
    [0x7f, 0x45, 0x4c, 0x46],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
    [0xd0, 0xcf, 0x11, 0xe0],
    [0x23, 0x21],
  ];
  for (const sig of signatures) {
    for (const path of ["a.bin", "a.wasm", "a.mp3", "a.woff2"]) {
      refused(checkSet([INDEX, bytesOf(path, ...sig)], "free"), "file_type_not_allowed", 400);
    }
  }
  // Text types are exempt: a script may start with `#!`.
  ok(checkSet([INDEX, { path: "cli.js", bytes: enc.encode("#!/usr/bin/env node\n") }], "free"));
});

test("D9: every image type passes with its own real header and fails without it", () => {
  const headers: Record<string, number[]> = {
    "a.jpg": [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46],
    "a.jpeg": [0xff, 0xd8, 0xff, 0xdb],
    "a.gif": [...GIF],
    "a.webp": [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20],
    "a.avif": [0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66],
    "a.ico": [0x00, 0x00, 0x01, 0x00, 0x01, 0x00],
    "a.bmp": [0x42, 0x4d, 0x3a, 0x00],
    "a.png": [...PNG],
  };
  for (const [path, header] of Object.entries(headers)) {
    ok(checkSet([INDEX, bytesOf(path, ...header)], "free"));
    assert.match(
      refused(checkSet([INDEX, bytesOf(path, 0x00, 0x11, 0x22)], "free"), "invalid_file", 400),
      new RegExp(`^${path.replace(".", "\\.")} isn't a valid ${extensionOf(path).toUpperCase()} file\\.$`),
    );
  }
  // An empty image has no signature either.
  refused(checkSet([INDEX, { path: "a.png", bytes: new Uint8Array(0) }], "free"), "invalid_file", 400);
});

test("each passing file carries SITE_FILE_TYPES' content type, in input order", () => {
  const typed = ok(
    checkSet(
      [INDEX, { path: "a.css", bytes: enc.encode("b{}") }, { path: "m/x.mjs", bytes: enc.encode("") }],
      "free",
    ),
  );
  assert.deepEqual(
    typed.map((f) => [f.path, f.contentType]),
    [
      ["index.html", SITE_FILE_TYPES.html.contentType],
      ["a.css", SITE_FILE_TYPES.css.contentType],
      ["m/x.mjs", SITE_FILE_TYPES.mjs.contentType],
    ],
  );
});
