/**
 * The legal texts (E06a, PRD §6 / D8, AC18–AC19; E07 AC29).
 *
 * `content/legal/*.md` must stay byte-identical to the reviewed texts. Their
 * sources are not in CI's reach, so each file's SHA-256 is pinned here instead.
 * When Arun fills the `[[…]]` placeholders (human step), he updates these
 * digests in the same commit; nobody else edits the texts — with one exception:
 * E07's decision D-67 (Arun, 2026-10-15) had Claude Code write `acceptable-use.md`
 * and the privacy policy's "Checking pages for abuse" and "Reports" sections
 * and point the Impressum's report line at `/report`, as finished text with no
 * `[[LAWYER…]]` markers, for Arun to review.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { ABUSE_CONTACT_EMAIL, MODERATION_REASON_SENTENCES } from "@kept/shared";

import {
  hasLegalPlaceholders,
  legalPlaceholdersRemain,
  legalSource,
  legalTitle,
  renderLegal,
} from "./index";
import { LEGAL_DOCS, LEGAL_LABELS, isLegalDoc, legalHref } from "./links";

const DELIVERED_SHA256 = {
  impressum: "7b5ade5d0c3b1bc4b32d05e2b65b4cf1f6ab20f911a93f4c827c3b31198a9a7b",
  privacy: "e2ad83d1be4e7041b6c95c6bfbb162f0d7747f1e8e963f401cc814cb8c7b0f8e",
  "acceptable-use": "931a1700be003308cf48bcea21dce39716959721d13fdf9204b1413638b882fb",
} as const satisfies Record<(typeof LEGAL_DOCS)[number], string>;

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

test("labels are exactly Impressum, Privacy and Acceptable use", () => {
  assert.deepEqual(LEGAL_DOCS, ["impressum", "privacy", "acceptable-use"]);
  assert.equal(LEGAL_LABELS.impressum, "Impressum");
  assert.equal(LEGAL_LABELS.privacy, "Privacy");
  assert.equal(LEGAL_LABELS["acceptable-use"], "Acceptable use");
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

test("the abuse texts link to /report and abuse@kept.host (AC29)", () => {
  assert.equal(legalTitle("acceptable-use"), "Acceptable use");
  const impressum = renderLegal("impressum");
  assert.match(impressum, /<a href="\/report">/);
  assert.match(impressum, new RegExp(`mailto:${ABUSE_CONTACT_EMAIL}`));
  const privacy = renderLegal("privacy");
  assert.match(privacy, /<h2>\d+\. Checking pages for abuse<\/h2>/);
  assert.match(privacy, /<h2>\d+\. Reports<\/h2>/);
  assert.match(privacy, /<a href="\/report">/);
  assert.ok(!privacy.includes("No automated decisions"));
  const aup = renderLegal("acceptable-use");
  assert.match(aup, /<a href="\/report">/);
  assert.ok(aup.includes(ABUSE_CONTACT_EMAIL));
  // Finished text (D-67): no placeholder may ever ship in the acceptable-use page.
  assert.ok(!hasLegalPlaceholders(legalSource("acceptable-use")));
});

test("every rule the statement of reasons cites exists in the acceptable-use page", () => {
  const source = legalSource("acceptable-use");
  const ruleNumbers = [...source.matchAll(/^### Rule (\d+):/gm)].map((m) => Number(m[1]));
  console.log(`[legal] acceptable-use rules: ${ruleNumbers.join(", ")}`);
  assert.deepEqual(ruleNumbers, [1, 2, 3, 4, 5, 6, 7]);
  for (const [reason, { aupSection }] of Object.entries(MODERATION_REASON_SENTENCES)) {
    if (aupSection === null) continue;
    assert.ok(ruleNumbers.includes(aupSection), `${reason} cites rule ${aupSection}, which the page lacks`);
  }
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
