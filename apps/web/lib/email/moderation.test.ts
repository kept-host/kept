/**
 * The statement of reasons and the moderation alerts (E07 task 004, AC14) —
 * pure builders, no network, no database; runs everywhere.
 *
 * AC14's elements, each asserted: the page address, what we did, why (Appendix
 * A's sentence + the acceptable-use rule), how it was decided, what the owner
 * can do (studio link for an owned page; the original link for an anonymous
 * one), and a removal's deadline (no download for child sexual abuse material).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MODERATION_REASON_SENTENCES } from "@kept/shared";

import { buildAdminAlertEmail } from "./admin-alert";
import {
  appealAlert,
  buildAppealRejectedEmail,
  buildStatementOfReasons,
  moderationAlert,
  type StatementInput,
} from "./moderation";

const origin = "https://app.kept.host";
const base: StatementInput = {
  to: "under_review",
  pageUrl: "https://k7f3q2xa.kept.host",
  siteId: "6f1d1f0e-2b9c-4f61-9a55-2f3c8c1e0a11",
  reason: "phishing",
  actor: "scanner",
  automated: true,
  note: null,
  appealGranted: false,
  owned: true,
  purgeAfter: null,
  origin,
  from: "kept <page@kept.host>",
};

/** Owners never see the scanner's rule or a probability (§9). */
function assertNoInternals(text: string): void {
  assert.doesNotMatch(text, /\bP[1-4]\b/);
  assert.doesNotMatch(text, /probab|score|threshold|confidence/i);
}

test("a scanner flag: address, action, reason + AUP rule, automated, studio appeal link", () => {
  const email = buildStatementOfReasons(base);
  console.log(`[sor] ${JSON.stringify(email)}`);
  assert.equal(email.subject, "Your kept page is hidden while we check it");
  assert.match(email.text, /hidden your page https:\/\/k7f3q2xa\.kept\.host while we take a look/);
  assert.ok(email.text.includes(MODERATION_REASON_SENTENCES.phishing.sentence));
  assert.match(email.text, /rule 1 of our acceptable-use rules: https:\/\/kept\.host\/legal\/acceptable-use/);
  assert.match(email.text, /an automated check flagged it\. Nobody has reviewed it yet\./);
  assert.ok(email.text.includes(`${origin}/site/${base.siteId}`));
  assert.match(email.text, /abuse@kept\.host/);
  assert.match(email.text, /Impressum: https:\/\/kept\.host\/legal\/impressum/);
  assertNoInternals(email.text);
});

test("an anonymous page: no studio link, the original link instead", () => {
  const email = buildStatementOfReasons({ ...base, owned: false });
  assert.doesNotMatch(email.text, /\/site\//);
  assert.doesNotMatch(email.text, /\/p\//);
  assert.match(email.text, /private link you were given when you published the page/);
});

test("a removal by a person: the deadline and a download for an owned page", () => {
  const email = buildStatementOfReasons({
    ...base,
    to: "removed",
    actor: "admin",
    automated: false,
    reason: "scam",
    note: "Asked for card numbers.",
    purgeAfter: new Date("2026-11-15T10:00:00Z"),
  });
  assert.equal(email.subject, "Your kept page was removed");
  assert.match(email.text, /How we decided: a person reviewed it\./);
  assert.match(email.text, /download it from that page until 15 November 2026/);
  assert.match(email.text, /A note from the person who reviewed it: Asked for card numbers\./);
  assertNoInternals(email.text);
});

test("child sexual abuse material: never a download, the deletion date only", () => {
  const email = buildStatementOfReasons({
    ...base,
    to: "removed",
    actor: "admin",
    automated: false,
    reason: "child_sexual_abuse",
    purgeAfter: new Date("2026-11-15T10:00:00Z"),
  });
  assert.doesNotMatch(email.text, /download/i);
  assert.match(email.text, /deleted for good on 15 November 2026/);
});

test("the report fast path says it was hidden automatically", () => {
  const email = buildStatementOfReasons({ ...base, to: "quarantined", actor: "report", reason: "child_sexual_abuse" });
  assert.equal(email.subject, "Your kept page is hidden");
  assert.match(email.text, /it was reported, and pages reported for this are hidden automatically/);
});

test("a restore after an appeal says so and offers no appeal", () => {
  const email = buildStatementOfReasons({
    ...base,
    to: "live",
    actor: "admin",
    automated: false,
    appealGranted: true,
  });
  assert.equal(email.subject, "Your kept page is back online");
  assert.match(email.text, /is back online/);
  assert.match(email.text, /We looked at your request for a review, and we agree\./);
  assert.doesNotMatch(email.text, /What you can do/);
});

test("`other` cites no single rule and carries the note", () => {
  const email = buildStatementOfReasons({ ...base, actor: "admin", automated: false, reason: "other", note: "Impersonates a bank." });
  assert.match(email.text, /Our acceptable-use rules: /);
  assert.doesNotMatch(email.text, /rule \d/);
  assert.match(email.text, /Impersonates a bank\./);
});

test("a rejected appeal carries the note", () => {
  const email = buildAppealRejectedEmail({
    pageUrl: base.pageUrl,
    note: "Still asks for passwords.",
    status: "quarantined",
    purgeAfter: null,
    origin,
    from: base.from,
  });
  assert.equal(email.subject, "Your review request was answered");
  assert.match(email.text, /the decision stands/);
  assert.match(email.text, /Still asks for passwords\./);
});

test("CSAM alerts are PRIORITY and start the subject line; others are not", () => {
  const report = {
    slug: "k7f3q2xa",
    pageUrl: base.pageUrl,
    from: "live",
    to: "quarantined",
    actor: "report",
    reason: "child_sexual_abuse",
    scanId: null,
    reportId: "0b6c3c1e-8f6f-4a8e-9a0c-2d1e3f4a5b6c",
    origin,
  } as const;
  const csam = moderationAlert(report);
  assert.equal(csam.priority, true);
  const subject = buildAdminAlertEmail({ ...csam, from: base.from, origin }).subject;
  assert.ok(subject.startsWith("PRIORITY "), subject);

  const flag = moderationAlert({ ...report, actor: "scanner", to: "under_review", reason: "phishing", reportId: null });
  assert.equal(flag.priority, false);
  assert.equal(buildAdminAlertEmail({ ...flag, from: base.from, origin }).subject, "[kept alert] k7f3q2xa flagged by the scanner");

  const appeal = appealAlert({
    slug: "k7f3q2xa",
    pageUrl: base.pageUrl,
    status: "under_review",
    reason: "phishing",
    message: "This is my own login page for my own app.",
    anonymous: true,
    origin,
  });
  assert.equal(appeal.subject, "Appeal on k7f3q2xa");
  assert.ok(appeal.lines.some((line) => line.includes("my own login page")));
});
