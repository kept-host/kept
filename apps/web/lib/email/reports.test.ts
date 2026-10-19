/**
 * The reporter's mails and the report alert (E07 task 010, AC17, AC18) — pure
 * builders, no network, no database; runs everywhere.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ABUSE_CONTACT_EMAIL } from "@kept/shared";

import { buildAdminAlertEmail } from "./admin-alert";
import { buildReportDecision, buildReportReceipt, reportAlert } from "./reports";

const origin = "https://app.kept.host";
const from = "kept <page@kept.host>";
const url = "https://k7f3q2xa.kept.host";

test("the receipt names the page, promises a decision and carries the legal footer", () => {
  const mail = buildReportReceipt({ url, from, origin });
  assert.equal(mail.subject, "We've got your report");
  assert.match(mail.text, /k7f3q2xa\.kept\.host/);
  assert.match(mail.text, /email you what we decide/);
  assert.ok(mail.text.includes(ABUSE_CONTACT_EMAIL));
  assert.match(mail.text, /Impressum: https:\/\//);
});

test("the decision says what happened and whether automated means were used", () => {
  const actioned = buildReportDecision({ url, outcome: "actioned", note: "Phishing kit.", automated: true, from, origin });
  assert.match(actioned.text, /took the page down/);
  assert.match(actioned.text, /automated checks were used/);
  assert.match(actioned.text, /A note from the person who reviewed it: Phishing kit\./);

  const dismissed = buildReportDecision({ url, outcome: "dismissed", note: null, automated: false, from, origin });
  assert.match(dismissed.text, /stays up/);
  assert.match(dismissed.text, /No automated means were used/);
  assert.doesNotMatch(dismissed.text, /A note from/);

  const gone = buildReportDecision({ url, outcome: "already_removed", note: "already removed", automated: false, from, origin });
  assert.match(gone.text, /had already been taken down/);
  assert.match(gone.text, /closed automatically/);
  assert.doesNotMatch(gone.text, /A note from/);
});

test("reporter mail never names a rule, a probability or a scan finding (§9)", () => {
  for (const mail of [
    buildReportReceipt({ url, from, origin }),
    buildReportDecision({ url, outcome: "actioned", note: null, automated: true, from, origin }),
  ]) {
    assert.doesNotMatch(mail.text, /\bP[1-4]\b|probab|confidence|threshold|harm/i);
  }
});

test("a report alert is PRIORITY only for child sexual abuse material, and carries no reporter identity", () => {
  const base = {
    reportId: "6f1d1f0e-2b9c-4f61-9a55-2f3c8c1e0a11",
    slug: "k7f3q2xa",
    pageUrl: url,
    status: "live" as const,
    details: "This page asks for my bank login and is not my bank.",
    origin,
  };
  const phishing = reportAlert({ ...base, category: "phishing" });
  assert.equal(phishing.priority, false);
  assert.equal(phishing.subject, "Report on k7f3q2xa: Phishing or stolen logins");
  assert.ok(phishing.lines.some((line) => line.includes(base.details)));
  assert.ok(phishing.lines.includes(`Review it: ${origin}/admin/moderation`));

  const csam = reportAlert({ ...base, category: "child_sexual_abuse" });
  const email = buildAdminAlertEmail({ subject: csam.subject, priority: csam.priority, lines: csam.lines, from, origin });
  assert.ok(email.subject.startsWith("PRIORITY "), email.subject);
  assert.doesNotMatch(email.text, /@resend\.dev|reporter/i);
});
