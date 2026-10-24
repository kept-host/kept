/**
 * E08 task 003 — D7 normalisation (AC4, AC6, AC7 and PRD §9 edge cases 1–5).
 * Pure; touches no store.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { PublishFailure } from "../pipeline";
import { isIgnored, normalise, type Normalised } from "./normalise";
import { isFailure, type RawFile } from "./types";

const enc = new TextEncoder();
const file = (path: string, text = path): RawFile => ({ path, bytes: enc.encode(text) });
const files = (...paths: string[]) => paths.map((path) => file(path));

function ok(result: Normalised | PublishFailure): Normalised {
  if (isFailure(result)) assert.fail(`expected a set, got ${JSON.stringify(result.body)}`);
  return result;
}

function refused(result: Normalised | PublishFailure, code: string): string {
  if (!isFailure(result)) assert.fail(`expected ${code}, got ${JSON.stringify(result.files.map((f) => f.path))}`);
  assert.equal(result.body.error, code, result.body.message);
  assert.equal(result.status, 400);
  return result.body.message;
}

const paths = (result: Normalised) => result.files.map((f) => f.path);

test("AC4: OS junk and dotfiles are dropped and listed in input order; .well-known is kept", () => {
  const result = ok(
    normalise(
      files(
        "index.html",
        "__MACOSX/._index.html",
        "assets/.DS_Store",
        "Thumbs.db",
        "img/desktop.ini",
        ".env",
        "src/.git/config",
        ".well-known/security.txt",
        "app.js",
      ),
    ),
  );
  assert.deepEqual(paths(result), ["index.html", ".well-known/security.txt", "app.js"]);
  assert.deepEqual(result.ignored, [
    "__MACOSX/._index.html",
    "assets/.DS_Store",
    "Thumbs.db",
    "img/desktop.ini",
    ".env",
    "src/.git/config",
  ]);
});

test("isIgnored: a `.`/`..` segment is not a dotfile — it must reach the path check", () => {
  assert.equal(isIgnored("../x.css"), false);
  assert.equal(isIgnored("a/./b.css"), false);
  assert.equal(isIgnored(".hidden/x.css"), true);
  assert.equal(isIgnored(".well-known/assetlinks.json"), false);
});

test("AC6: each malformed path is invalid_path, naming the first offender sanitised", () => {
  for (const bad of [
    "../secret.css",
    "a/../b.css",
    "/etc/passwd.txt",
    "a\\b.css",
    "a\u0001b.css",
    "a//b.css",
    `${Array.from({ length: 17 }, (_, i) => `d${i}`).join("/")}.css`,
    `${"x".repeat(513)}.css`,
  ]) {
    const message = refused(normalise([file("index.html"), file(bad), file("zz/also\\bad.css")]), "invalid_path");
    assert.doesNotMatch(message, /[\u0000-\u001f]/u, `message is sanitised: ${JSON.stringify(message)}`);
    assert.ok(!message.includes("also"), `the FIRST offender is named: ${message}`);
  }
  assert.match(
    refused(normalise(files("index.html", "a\u0001b.css")), "invalid_path"),
    /^a\?b\.css has a name/,
  );
});

test("AC6: two paths equal ignoring case are invalid_path; exact case is kept otherwise", () => {
  refused(normalise(files("index.html", "Logo.png", "logo.PNG")), "invalid_path");
  refused(normalise(files("index.html", "a.css", "a.css")), "invalid_path");
  const result = ok(normalise(files("index.html", "assets/App-AbC.js", "assets/app-xyz.js")));
  assert.deepEqual(paths(result), ["index.html", "assets/App-AbC.js", "assets/app-xyz.js"]);
});

test("D7: paths are stored NFC", () => {
  const nfd = "café.css";
  const result = ok(normalise([file("index.html"), file(nfd)]));
  assert.equal(result.files[1]!.path, "café.css");
  // …and an NFC/NFD pair is one path, so it collides.
  refused(normalise([file("index.html"), file(nfd), file("café.css")]), "invalid_path");
});

test("AC7: anything under _kept/ is invalid_path — also when a stripped folder lifts it there", () => {
  refused(normalise(files("index.html", "_kept/readme.html")), "invalid_path");
  refused(normalise(files("index.html", "_KEPT/x.css")), "invalid_path");
  refused(normalise(files("dist/index.html", "dist/_kept/x.css")), "invalid_path");
});

test("D7 step 3: one shared top folder is stripped when there is no root index.html", () => {
  const result = ok(normalise(files("dist/index.html", "dist/assets/a.js", "dist/vite.svg")));
  assert.deepEqual(paths(result), ["index.html", "assets/a.js", "vite.svg"]);
});

test("edge case 1: a root index.html wins and nothing is stripped", () => {
  const result = ok(normalise(files("index.html", "site/index.html", "site/a.css")));
  assert.deepEqual(paths(result), ["index.html", "site/index.html", "site/a.css"]);
});

test("edge case 2: dist/ and src/ — no single top folder → missing_index", () => {
  const message = refused(normalise(files("dist/index.html", "src/main.ts.txt")), "missing_index");
  assert.match(message, /^There's no index\.html at the top of this folder/);
});

test("edge case 3 / D7 step 4: the only HTML file, at the root, becomes index.html", () => {
  assert.deepEqual(paths(ok(normalise(files("game.html")))), ["index.html"]);
  assert.deepEqual(paths(ok(normalise(files("about.htm", "style.css")))), ["index.html", "style.css"]);
  // …also after a strip.
  assert.deepEqual(paths(ok(normalise(files("site/about.html", "site/a.css")))), ["index.html", "a.css"]);
});

test("a lone HTML file that is NOT at the root is not moved → missing_index", () => {
  refused(normalise(files("pages/about.html", "style.css")), "missing_index");
});

test("edge case 4: two HTML files and no index.html → missing_index", () => {
  refused(normalise(files("a.html", "b.html")), "missing_index");
});

test("a set of only junk is missing_index, not an empty publish", () => {
  refused(normalise(files(".DS_Store", "__MACOSX/x")), "missing_index");
});

test("has404 is a root 404.html, nothing else", () => {
  assert.equal(ok(normalise(files("index.html", "404.html"))).has404, true);
  assert.equal(ok(normalise(files("index.html", "docs/404.html"))).has404, false);
  assert.equal(ok(normalise(files("index.html"))).has404, false);
});

test("bytes travel untouched through normalising", () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x3c]);
  const result = ok(normalise([{ path: "dist/page.html", bytes }]));
  assert.equal(result.files[0]!.path, "index.html");
  assert.equal(result.files[0]!.bytes, bytes);
});
