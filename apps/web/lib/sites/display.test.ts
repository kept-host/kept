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

import {
  DRAFT_GRACE_DAYS,
  DRAFT_TTL_DAYS,
  limitsFor,
  SITE_STATUSES,
  type SiteStatus,
} from "@kept/shared";

import {
  DRAFT_URGENT_HOURS,
  atLimitBanner,
  atLimitPublishToast,
  demoteConsequence,
  effectiveStatus,
  expiredDraftNotice,
  formatBytes,
  formatUpdatedAt,
  isDraftUrgent,
  isManagementRestricted,
  managementRefusal,
  pageName,
  prunedVersionsNote,
  KEPT_TOAST,
  REPLACED_TOAST,
  noSearchResults,
  PUBLISHED_KEPT_TOAST,
  SWAPPED_TOAST,
  visitsLabel,
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

test("the studio's toasts and banner are the PRD's sentences, with the limit interpolated", () => {
  assert.equal(PUBLISHED_KEPT_TOAST, "Published. It's kept.");
  assert.equal(KEPT_TOAST, "Kept. It's permanent now.");
  assert.equal(SWAPPED_TOAST, "Swapped.");
  assert.equal(
    atLimitPublishToast(1234),
    "Published as a draft — you're keeping 1234 of 1234. Swap one out to keep it.",
  );
  assert.equal(
    atLimitBanner(1234),
    "You're keeping 1234 of 1234. New pages land as drafts — swap one out to keep it.",
  );
  assert.equal(noSearchResults("tide"), "No pages match 'tide'.");
  assert.equal(REPLACED_TOAST, "Replaced. Same link, new version.");
});

test("the pruned-version note follows the plan's count", () => {
  assert.equal(
    prunedVersionsNote(limitsFor("free").previousVersions),
    "Free accounts keep one previous version.",
  );
  assert.equal(prunedVersionsNote(3), "Free accounts keep 3 previous versions.");
});

test("visits are counted in words the card and the chooser share", () => {
  assert.equal(visitsLabel(1), "1 visit");
  assert.equal(visitsLabel(0), "0 visits");
  assert.equal(visitsLabel(4210), "4,210 visits");
});

test("an at-limit publish reads as a success, never as a refusal", () => {
  const sentence = atLimitPublishToast(9);
  assert.match(sentence, /^Published/);
  assert.doesNotMatch(sentence, /could not|couldn't|failed|error/i);
});

// ── The drafts strip (E06 task 010; PRD §5.1, §9.1, AC9) ──────────────────────

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test("AC9: a draft turns urgent inside its last DRAFT_URGENT_HOURS, not before", () => {
  const now = new Date("2026-10-04T12:00:00Z");
  const at = (ms: number) => new Date(now.getTime() + ms);
  assert.equal(isDraftUrgent(at(DRAFT_URGENT_HOURS * HOUR + 1), now), false);
  assert.equal(isDraftUrgent(at(DRAFT_URGENT_HOURS * HOUR), now), true);
  assert.equal(isDraftUrgent(at(1), now), true);
  // Past `expires_at` it is expired, which is a different state, not "urgent".
  assert.equal(isDraftUrgent(at(0), now), false);
  assert.equal(isDraftUrgent(at(-HOUR), now), false);
});

test("an expired draft in grace says how long ago, and how long is left to keep it", () => {
  const expiresAt = new Date("2026-10-01T12:00:00Z");
  const purgeAfter = new Date(expiresAt.getTime() + DRAFT_GRACE_DAYS * DAY);
  const now = new Date(expiresAt.getTime() + 3 * DAY + HOUR);
  assert.equal(
    expiredDraftNotice(expiresAt, purgeAfter, now),
    `Expired 3 days ago — keep within ${DRAFT_GRACE_DAYS - 3} days`,
  );
});

test("an expired notice says 'today' and '1 day' rather than '0 days' or '1 days'", () => {
  const expiresAt = new Date("2026-10-01T12:00:00Z");
  assert.equal(
    expiredDraftNotice(expiresAt, new Date(expiresAt.getTime() + DAY), new Date(expiresAt.getTime() + HOUR)),
    "Expired today — keep within 1 day",
  );
  assert.equal(
    expiredDraftNotice(
      expiresAt,
      new Date(expiresAt.getTime() + 10 * DAY),
      new Date(expiresAt.getTime() + DAY),
    ),
    "Expired 1 day ago — keep within 9 days",
  );
});

test("past purge_after, or with no grace recorded, the notice promises nothing", () => {
  const expiresAt = new Date("2026-10-01T12:00:00Z");
  const purgeAfter = new Date(expiresAt.getTime() + 2 * DAY);
  const now = new Date(expiresAt.getTime() + 2 * DAY + HOUR);
  assert.equal(expiredDraftNotice(expiresAt, purgeAfter, now), "Expired 2 days ago");
  assert.equal(expiredDraftNotice(expiresAt, null, now), "Expired 2 days ago");
});
