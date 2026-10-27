/**
 * `cleanProvenance` — E09 task 005. Pure: no stores, no database, runs in CI.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { PAGE_TITLE_MAX_LENGTH, PROVENANCE_LIMITS } from "@kept/shared";

import { cleanProvenance, provenanceOf } from "./provenance";

test("nothing sent is `{}` — absent stays absent, never null", () => {
  assert.deepEqual(cleanProvenance({}), {});
  assert.deepEqual(cleanProvenance({ model: "   ", tool: "", prompt: "\u0000\u0007" }), {});
});

test("every field is trimmed and stripped of control characters", () => {
  const out = cleanProvenance({
    model: "  claude\u0000-opus\u007F ",
    tool: "co\u0085dex",
    prompt: " line one\n\tline two\r\u0001 ",
    readme: "# Title\n\n\tbody\u001B[31m",
  });
  assert.deepEqual(out, {
    model: "claude-opus",
    tool: "codex",
    // `\n` and `\t` survive in the two multi-line fields; `\r` does not.
    prompt: "line one\n\tline two",
    readme: "# Title\n\n\tbody[31m",
  });
  // Single-line fields lose `\n` and `\t` too.
  assert.equal(cleanProvenance({ tool: "a\nb\tc" }).tool, "abc");
});

test("the caps are PROVENANCE_LIMITS, counted in code points", () => {
  const out = cleanProvenance({
    model: "m".repeat(PROVENANCE_LIMITS.model + 10),
    prompt: "😀".repeat(PROVENANCE_LIMITS.prompt + 1),
  });
  assert.equal(out.model?.length, PROVENANCE_LIMITS.model);
  assert.equal(Array.from(out.prompt ?? "").length, PROVENANCE_LIMITS.prompt);
  assert.ok(!out.prompt?.includes("�"), "never cut through a surrogate pair");
});

test("title goes through the page-title cleaning: decoded, tag-stripped, collapsed, capped", () => {
  assert.equal(cleanProvenance({ title: "  My\u0007  &amp; <b>page</b>\n " }).title, "My & page");
  assert.equal(cleanProvenance({ title: "<br>" }).title, undefined);
  assert.equal(
    Array.from(cleanProvenance({ title: "t".repeat(PAGE_TITLE_MAX_LENGTH * 2) }).title ?? "").length,
    PAGE_TITLE_MAX_LENGTH,
  );
});

test("source_url: http(s) only, normalised by the URL parser, else dropped", () => {
  assert.equal(cleanProvenance({ source_url: " https://Example.com/a b " }).sourceUrl, "https://example.com/a%20b");
  assert.equal(cleanProvenance({ source_url: "http://example.com" }).sourceUrl, "http://example.com/");
  for (const bad of ["javascript:alert(1)", "ftp://example.com/x", "data:text/html,x", "not a url", "//example.com"]) {
    assert.equal(cleanProvenance({ source_url: bad }).sourceUrl, undefined, bad);
  }
  const long = `https://example.com/${"a".repeat(PROVENANCE_LIMITS.source_url)}`;
  assert.equal(cleanProvenance({ source_url: long }).sourceUrl, undefined, "over the cap is dropped, not cut");
});

test("remix_of: a valid slug is kept for the SQL to resolve; anything else is dropped", () => {
  assert.equal(cleanProvenance({ remix_of: "k3n8vq2p" }).remixOf, "k3n8vq2p");
  assert.equal(cleanProvenance({ remix_of: "Not A Slug" }).remixOf, undefined);
  assert.equal(cleanProvenance({ remix_of: "" }).remixOf, undefined);
});

test("provenanceOf picks only the provenance keys out of an envelope", () => {
  const envelope = { html: "<p>", reminderEmail: "a@b.c", model: "m", remix_of: "x" };
  assert.deepEqual(
    Object.fromEntries(Object.entries(provenanceOf(envelope)).filter(([, v]) => v !== undefined)),
    { model: "m", remix_of: "x" },
  );
});
