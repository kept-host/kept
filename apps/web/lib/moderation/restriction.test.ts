/**
 * The restricted banner's view model (E07 task 009, §9) — `restrictionView`,
 * pure: the rows in, what the owner may read and do out. The reads behind it
 * (`readRestriction`) are driven end to end by `e2e/site-detail.spec.ts` and
 * `e2e/anon-screens.spec.ts` against the real dev database.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { APPEALS_PER_SITE_WINDOW, MODERATION_REASON_SENTENCES, MODERATION_REASONS } from "@kept/shared";

import type { RestrictionRecord } from "../db/queries/restriction";
import { MS_PER_DAY } from "../sites/display";

import { isRestrictedSite, restrictionView, withholdsBytes, type RestrictedSite } from "./restriction";

const PURGE = new Date("2026-11-15T00:00:00Z");
const NO_HISTORY: RestrictionRecord = { latestAppeal: null, window: { count: 0, oldest: null }, latestAction: null };

function site(overrides: Partial<RestrictedSite> = {}): RestrictedSite {
  return { id: crypto.randomUUID(), status: "under_review", moderationReason: "phishing", purgeAfter: null, ...overrides };
}

test("only the three restricted statuses get the banner", () => {
  for (const status of ["under_review", "quarantined", "removed"] as const) {
    assert.equal(isRestrictedSite({ status }), true, status);
  }
  for (const status of ["live", "expired", "archived"] as const) {
    assert.equal(isRestrictedSite({ status }), false, status);
  }
});

test("only child sexual abuse material withholds the bytes (D13)", () => {
  for (const reason of MODERATION_REASONS) {
    assert.equal(withholdsBytes({ moderationReason: reason }), reason === "child_sexual_abuse", reason);
  }
  assert.equal(withholdsBytes({ moderationReason: null }), false);
});

test("the reason is Appendix A's sentence — never a reason code, a rule or a score", () => {
  for (const reason of MODERATION_REASONS) {
    const view = restrictionView(site({ moderationReason: reason }), NO_HISTORY);
    assert.equal(view.reason, MODERATION_REASON_SENTENCES[reason].sentence);
    assert.ok(!view.reason.includes("_"), `${reason}: no reason code in the copy`);
    assert.doesNotMatch(view.reason, /\d\.\d|%|probab|score|rule \w+_/i);
  }
  assert.equal(restrictionView(site({ moderationReason: null }), NO_HISTORY).reason, null);
});

test("only a person's note is shown; the scanner's and a report's never are", () => {
  const withNote = (actor: "scanner" | "report" | "admin") =>
    restrictionView(site(), { ...NO_HISTORY, latestAction: { actor, note: "Looks like a bank login." } }).note;
  assert.equal(withNote("admin"), "Looks like a bank login.");
  assert.equal(withNote("scanner"), null);
  assert.equal(withNote("report"), null);
});

test("removed: a download until purge_after, except withheld bytes; flagged: neither", () => {
  const removed = restrictionView(site({ status: "removed", purgeAfter: PURGE }), NO_HISTORY);
  assert.deepEqual([removed.downloadable, removed.deletesOn], [true, PURGE]);

  const csam = restrictionView(
    site({ status: "removed", purgeAfter: PURGE, moderationReason: "child_sexual_abuse" }),
    NO_HISTORY,
  );
  assert.deepEqual([csam.downloadable, csam.deletesOn], [false, PURGE]);

  for (const status of ["under_review", "quarantined"] as const) {
    const view = restrictionView(site({ status, purgeAfter: PURGE }), NO_HISTORY);
    assert.deepEqual([view.downloadable, view.deletesOn], [false, null], status);
  }
});

test("appeal standing: available, open, rejected with its note, and the 3-per-30-days limit", () => {
  assert.deepEqual(restrictionView(site(), NO_HISTORY).appeal, { state: "available", rejectedNote: null });

  assert.deepEqual(
    restrictionView(site(), {
      ...NO_HISTORY,
      latestAppeal: { status: "open", decisionNote: null },
      window: { count: 1, oldest: new Date() },
    }).appeal,
    { state: "open" },
  );

  assert.deepEqual(
    restrictionView(site(), {
      ...NO_HISTORY,
      latestAppeal: { status: "rejected", decisionNote: "It still asks for card numbers." },
      window: { count: 1, oldest: new Date() },
    }).appeal,
    { state: "available", rejectedNote: "It still asks for card numbers." },
  );

  const oldest = new Date("2026-10-01T12:00:00Z");
  assert.deepEqual(
    restrictionView(site(), {
      ...NO_HISTORY,
      latestAppeal: { status: "rejected", decisionNote: "No." },
      window: { count: APPEALS_PER_SITE_WINDOW.limit, oldest },
    }).appeal,
    {
      state: "limited",
      rejectedNote: "No.",
      retryAt: new Date(oldest.getTime() + APPEALS_PER_SITE_WINDOW.days * MS_PER_DAY),
    },
  );

  // A granted appeal is history: the page was restored, then restricted again.
  assert.deepEqual(
    restrictionView(site(), {
      ...NO_HISTORY,
      latestAppeal: { status: "granted", decisionNote: "Fine." },
      window: { count: 1, oldest: new Date() },
    }).appeal,
    { state: "available", rejectedNote: null },
  );
});
