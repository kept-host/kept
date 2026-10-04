/**
 * The client pre-flight every drop surface reads — E06 task 010 (AC7, client
 * half; edge case 11).
 *
 * `checkPageFile` is what lets `DropTarget`, the landing tile and the anonymous
 * replace refuse a file **before any request**: a `.png` or an oversize page
 * never reaches the wire. Real `File` objects, real `MAX_PAGE_BYTES`, no mocks.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_PAGE_BYTES } from "@kept/shared";

import { checkPageFile, publishErrorText } from "./client";

const PAGE = "<!doctype html><title>t</title><p>hello</p>";

test("AC7: a .png is refused with the PRD's sentence, naming what it was", () => {
  const refusal = checkPageFile(new File([new Uint8Array(64)], "photo.png", { type: "image/png" }));
  assert.ok(refusal, "a .png must be refused before any request");
  assert.equal(
    publishErrorText(refusal),
    "That's a .png. kept publishes HTML pages — drop an .html file.",
  );
});

test("a file with no extension and no type is refused without inventing one", () => {
  const refusal = checkPageFile(new File(["plain"], "README", { type: "" }));
  assert.equal(
    refusal?.message,
    "That isn't an HTML file. kept publishes HTML pages — drop an .html file.",
  );
});

test("edge case 11: a page over MAX_PAGE_BYTES is refused with the limit in the copy", () => {
  const refusal = checkPageFile(
    new File([new Uint8Array(MAX_PAGE_BYTES + 1)], "big.html", { type: "text/html" }),
  );
  assert.equal(refusal?.error, "page_too_large");
  const mb = Math.round(MAX_PAGE_BYTES / (1024 * 1024));
  assert.match(refusal!.message, new RegExp(`over the ${mb} MB limit`));
});

test("a page exactly at MAX_PAGE_BYTES is accepted", () => {
  const file = new File([new Uint8Array(MAX_PAGE_BYTES)], "edge.html", { type: "text/html" });
  assert.equal(checkPageFile(file), null);
});

test("text/html and .html / .htm are accepted", () => {
  assert.equal(checkPageFile(new File([PAGE], "page.html", { type: "text/html" })), null);
  assert.equal(checkPageFile(new File([PAGE], "page.htm", { type: "text/html" })), null);
  assert.equal(
    checkPageFile(new File([PAGE], "page.html", { type: "text/html; charset=utf-8" })),
    null,
  );
  // Some browsers hand over an empty type; the extension decides then.
  assert.equal(checkPageFile(new File([PAGE], "page.html", { type: "" })), null);
  assert.equal(checkPageFile(new File([PAGE], "page.htm", { type: "" })), null);
});

test("an empty HTML file is refused", () => {
  const refusal = checkPageFile(new File([], "empty.html", { type: "text/html" }));
  assert.equal(refusal?.error, "empty_page");
});
