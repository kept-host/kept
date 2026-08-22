/**
 * The presentation rules, asserted where they can actually be run — E06 task 003.
 *
 * `effectiveStatus` is the one with teeth: it is the difference between a
 * dashboard that tells the truth about an unswept draft and one that does not.
 * No mocks, no fixtures, no database — these are pure functions and the test is
 * the function's own arithmetic.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { DRAFT_TTL_DAYS, SITE_STATUSES, type SiteStatus } from "@kept/shared";

import {
  atCapPublishNotice,
  demoteConsequence,
  effectiveStatus,
  formatBytes,
  formatUpdatedAt,
  isManagementRestricted,
  managementRefusal,
  pageName,
  publishedKeptNotice,
  siteHref,
  swapConsequence,
  swapRefusal,
} from "./display";

test("a live row whose clock has run out is presented as expired", () => {
  // The row still says `live` — E07's sweep has not run — and the card must not
  // repeat it.
  assert.equal(effectiveStatus("live", true), "expired");
});

test("a live row inside its clock is left alone", () => {
  assert.equal(effectiveStatus("live", false), "live");
});

test("a status E07 wrote is never overruled by the clock", () => {
  for (const status of ["quarantined", "under_review", "archived", "removed"] as const) {
    assert.equal(effectiveStatus(status, true), status);
    assert.equal(effectiveStatus(status, false), status);
  }
});

test("every status has a defined presentation, including ones added later", () => {
  for (const status of SITE_STATUSES as readonly SiteStatus[]) {
    // No throw, and a boolean that agrees with the sentence.
    assert.equal(
      isManagementRestricted(status),
      managementRefusal(status) !== null,
    );
  }
});

test("the two reviewed statuses refuse management with an explanation", () => {
  for (const status of ["quarantined", "under_review"] as const) {
    const refusal = managementRefusal(status);
    assert.ok(refusal, `${status} must explain itself`);
    // The refusal names what is on hold AND what still works — a dead end is
    // the failure mode this copy exists to avoid.
    assert.match(refusal, /on hold/);
    assert.match(refusal, /Deleting still works/);
  }
});

test("a healthy page refuses nothing", () => {
  assert.equal(managementRefusal("live"), null);
  assert.equal(isManagementRestricted("live"), false);
});

test("sizes read as sizes", () => {
  assert.equal(formatBytes(null), null);
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(4300), "4.2 KB");
  // Past 10 KB the decimal is noise on a line that already carries a date.
  assert.equal(formatBytes(150_000), "146 KB");
  assert.equal(formatBytes(2_500_000), "2.4 MB");
});

test("the updated stamp is pinned, so it cannot drift with the host's locale", () => {
  assert.equal(
    formatUpdatedAt(new Date("2026-08-22T23:30:00.000Z")),
    "22 Aug 2026",
  );
  // Pinned to UTC: an instant late in the UTC day must not roll forward or back
  // because the machine rendering it sits in another timezone.
  assert.equal(
    formatUpdatedAt(new Date("2026-01-01T00:15:00.000Z")),
    "1 Jan 2026",
  );
});

test("cards point at the detail route task 008 lands", () => {
  assert.equal(siteHref("k3n8vq2p"), "/site/k3n8vq2p");
});

test("a page is named by its title, and by its slug only when it has none", () => {
  assert.equal(pageName({ title: "Recipe notes", slug: "k3n8vq2p" }), "Recipe notes");
  assert.equal(pageName({ title: null, slug: "k3n8vq2p" }), "k3n8vq2p");
});

test("only a live kept page may be swapped out", () => {
  // Demoting anything else frees no slot: the cap counts `expires_at IS NULL AND
  // status = 'live'`, so the swap would cost a permanent page and gain nothing.
  assert.equal(swapRefusal("live"), null);
  for (const status of SITE_STATUSES as readonly SiteStatus[]) {
    if (status === "live") continue;
    assert.ok(swapRefusal(status), `${status} must explain why it cannot be swapped out`);
  }
});

test("a page held under review refuses a swap in the same words it refuses everything else", () => {
  for (const status of ["quarantined", "under_review"] as const) {
    assert.equal(swapRefusal(status), managementRefusal(status));
  }
});

test("the swap warning names both pages and never types the draft clock", () => {
  const sentence = swapConsequence("Recipe notes", "Trip plan");

  assert.match(sentence, /Recipe notes/);
  assert.match(sentence, /Trip plan/);
  // The demoted page is the one that gets the clock, and the clock is the
  // constant — a literal here is the product lying the day it moves.
  assert.match(sentence, new RegExp(`expires in ${DRAFT_TTL_DAYS} days`));
  assert.match(sentence, /Nothing is deleted/);
});

test("the demote warning names the page, states the fresh clock and destroys nothing", () => {
  const sentence = demoteConsequence("Recipe notes");

  assert.match(sentence, /Recipe notes/);
  // Demote sets a FRESH clock, so the constant is substituted for the same
  // reason `swapConsequence` substitutes it.
  assert.match(sentence, new RegExp(`expires in ${DRAFT_TTL_DAYS} days`));
  assert.match(sentence, /Nothing is deleted/);
  // The page keeps serving — demote removes nothing, and a warning that implied
  // otherwise would stop people using a control that is meant to be cheap.
  assert.match(sentence, /same link/);
  // One page, not two: the swap sentence's second name has no meaning here.
  assert.doesNotMatch(sentence, /is kept for good/);
});

test("a kept publish says the link works and promises nothing about a clock", () => {
  const sentence = publishedKeptNotice("Recipe notes");

  assert.match(sentence, /Recipe notes/);
  assert.match(sentence, /kept for good/);
  // There is no deadline on a kept page, so there must be no word about one.
  assert.doesNotMatch(sentence, /expires|draft|days/i);
});

test("an at-cap publish reads as a success with a clock, never as a refusal", () => {
  const sentence = atCapPublishNotice("Recipe notes");

  assert.match(sentence, /Recipe notes/);
  // The page IS published — HTTP 200, epic D1. Copy that led with the failure
  // would contradict the locked decision that the cap degrades, never errors.
  assert.match(sentence, /published and live/);
  assert.match(sentence, /Nothing failed/);
  assert.match(sentence, new RegExp(`expires in ${DRAFT_TTL_DAYS} days`));
  assert.doesNotMatch(sentence, /could not|couldn't|failed to|error/i);
});

test("neither publish sentence types the draft clock as a literal", () => {
  for (const sentence of [publishedKeptNotice("A"), atCapPublishNotice("A")]) {
    // The only digits allowed are the ones the constant put there.
    const digits = sentence.match(/\d+/g) ?? [];
    for (const digit of digits) assert.equal(digit, String(DRAFT_TTL_DAYS));
  }
});
