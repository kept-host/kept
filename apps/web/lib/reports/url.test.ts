/**
 * `reportedSlug` (E07 task 010): only `{slug}.{base}` is a kept page. Pure — no
 * network, no database; runs everywhere.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { reportedSlug } from "./url";

const BASE = "kept.host";

test("a page link, with or without a scheme, path or query, names its slug", () => {
  for (const link of [
    "https://k7f3q2xa.kept.host",
    "https://k7f3q2xa.kept.host/",
    "http://k7f3q2xa.kept.host/index.html?x=1#top",
    "  https://K7F3Q2XA.Kept.Host  ",
    "k7f3q2xa.kept.host",
    "k7f3q2xa.kept.host/some/path",
    "https://k7f3q2xa.kept.host./",
  ]) {
    assert.equal(reportedSlug(link, BASE), "k7f3q2xa", link);
  }
  assert.equal(reportedSlug("https://my-page.kept-dev.xyz", "kept-dev.xyz"), "my-page");
});

test("anything that is not exactly one label under the serving domain is refused", () => {
  for (const link of [
    "",
    "not a url",
    "https://kept.host",
    "https://a.b.kept.host",
    "https://k7f3q2xa.kept.host.evil.example",
    "https://k7f3q2xa.notkept.host",
    "https://evil.example/k7f3q2xa.kept.host",
    "ftp://k7f3q2xa.kept.host",
    "javascript:alert(1)",
    "https://-bad-.kept.host",
    "https://under_score.kept.host",
  ]) {
    assert.equal(reportedSlug(link, BASE), null, link);
  }
});
