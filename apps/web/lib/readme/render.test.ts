/**
 * The README renderer (E10 D6, AC10): strangers' markdown on kept's own CSP.
 * Pure — no store, no env.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { PROVENANCE_LIMITS } from "@kept/shared";

import { renderReadme } from "./render";

test("AC10: raw HTML in the markdown comes out as escaped text", () => {
  const html = renderReadme('Hi <script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n<a href="/x">raw</a>');
  assert.ok(!html.includes("<script"), html);
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), html);
  assert.ok(!/<img/i.test(html), html);
  assert.ok(!html.includes('<a href="/x">'), html);
});

test("no images: ![alt](url) renders as a link, never an <img> (KEPT_OWN_CSP)", () => {
  const html = renderReadme("![a cat](https://example.com/cat.png)");
  assert.ok(!/<img/i.test(html), html);
  assert.match(html, /<a href="https:\/\/example\.com\/cat\.png" rel="nofollow ugc noopener">a cat<\/a>/);
});

test("links: http(s) and mailto only, each rel=\"nofollow ugc noopener\"", () => {
  const html = renderReadme(
    "[web](https://kept.host) [mail](mailto:a@b.c) [js](javascript:alert(1)) [data](data:text/html,x) [rel](/path)",
  );
  assert.match(html, /<a href="https:\/\/kept\.host" rel="nofollow ugc noopener">web<\/a>/);
  assert.match(html, /<a href="mailto:a@b\.c" rel="nofollow ugc noopener">mail<\/a>/);
  assert.ok(!/href="(javascript|data):/i.test(html), html);
  assert.ok(!html.includes('href="/path"'), html);
  assert.equal(html.match(/<a /g)?.length, 2);
});

test("no linkify: a bare URL stays text", () => {
  assert.ok(!renderReadme("see https://kept.host").includes("<a"));
});

test("headings, lists and code render", () => {
  const html = renderReadme("## Steps\n\n- one\n- two\n\n```\nconst x = '<b>';\n```");
  assert.match(html, /<h2>Steps<\/h2>/);
  assert.match(html, /<li>one<\/li>/);
  assert.match(html, /<pre><code>const x = '&lt;b&gt;';/);
});

test("input is held to PROVENANCE_LIMITS.readme", () => {
  const html = renderReadme("a".repeat(PROVENANCE_LIMITS.readme + 500));
  assert.equal(html, `<p>${"a".repeat(PROVENANCE_LIMITS.readme)}</p>\n`);
});
