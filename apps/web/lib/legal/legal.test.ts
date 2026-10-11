/**
 * The legal texts (E06a, PRD §6 / D8, AC18–AC19).
 *
 * `content/legal/*.md` must stay byte-identical to the files delivered with the
 * PRD. Those live under `.agent/`, which is gitignored, so CI cannot compare
 * against them — the delivered files' SHA-256 is pinned here instead. When Arun
 * fills the `[[…]]` placeholders (human step), he updates these two digests in
 * the same commit; nobody else edits the texts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  hasLegalPlaceholders,
  legalPlaceholdersRemain,
  legalSource,
  legalTitle,
  renderLegal,
} from "./index";
import { LEGAL_DOCS, LEGAL_LABELS, isLegalDoc, legalHref } from "./links";

const DELIVERED_SHA256 = {
  impressum: "ed0f11cadf50d208aea0f5779cd704b36ca530de62e7808830adfd80dd3f2e41",
  privacy: "1bb2e5e113ac12d7064205d874601b3a111ca92a06a8cc32af68256051368099",
} as const;

test("each legal file is byte-identical to the delivered text", () => {
  for (const doc of LEGAL_DOCS) {
    const bytes = readFileSync(
      path.join(process.cwd(), "content", "legal", `${doc}.md`)
    );
    const digest = createHash("sha256").update(bytes).digest("hex");
    console.log(`[legal] ${doc}.md sha256=${digest}`);
    assert.equal(
      digest,
      DELIVERED_SHA256[doc],
      `${doc}.md differs from the delivered file`
    );
  }
});

test("labels are exactly Impressum and Privacy", () => {
  assert.deepEqual(LEGAL_DOCS, ["impressum", "privacy"]);
  assert.equal(LEGAL_LABELS.impressum, "Impressum");
  assert.equal(LEGAL_LABELS.privacy, "Privacy");
  assert.ok(isLegalDoc("privacy"));
  assert.ok(!isLegalDoc("terms"));
});

test("renders headings, lists and links; first heading is the title", () => {
  assert.equal(legalTitle("impressum"), "Impressum");
  assert.equal(legalTitle("privacy"), "Privacy policy");
  const privacy = renderLegal("privacy");
  assert.match(privacy, /<h1>Privacy policy<\/h1>/);
  assert.match(privacy, /<h2>/);
  assert.match(privacy, /<ul>\s*<li>/);
  assert.match(privacy, /<a href="\/legal\/impressum">Impressum<\/a>/);
  // The Impressum's one-field-per-line address block keeps its line breaks.
  assert.match(renderLegal("impressum"), /<br>/);
});

test("placeholder detection — the delivered texts still carry [[…]]", () => {
  assert.ok(hasLegalPlaceholders("Name: [[FULL NAME]]"));
  assert.ok(!hasLegalPlaceholders("Name: Arun"));
  assert.equal(
    legalPlaceholdersRemain(),
    LEGAL_DOCS.some((doc) => legalSource(doc).includes("[["))
  );
});

test("legal hrefs come from configuration: apex-absolute with an app. host, relative on one origin", () => {
  assert.equal(
    legalHref("impressum", "https://app.kept.host"),
    "https://kept.host/legal/impressum"
  );
  assert.equal(
    legalHref("privacy", "https://app.kept-dev.xyz/"),
    "https://kept-dev.xyz/legal/privacy"
  );
  assert.equal(
    legalHref("privacy", "https://localhost:3000"),
    "/legal/privacy"
  );
  assert.equal(legalHref("privacy", undefined), "/legal/privacy");
});
