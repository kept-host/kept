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
  NAME_HOLD_DAYS,
  PUBLISH_CHANNELS,
  SITE_STATUSES,
  type SiteStatus,
} from "@kept/shared";

import { DRAFT_NAME_NOTE, NAME_HOLD_PERIOD, namesUsed, renameWarning } from "../names/messages";

import {
  DRAFT_URGENT_HOURS,
  atLimitBanner,
  bulkFailedToast,
  bulkKeepRefusal,
  deleteDraftsNote,
  deleteDraftsTitle,
  draftMatchesFilter,
  draftsDeletedToast,
  draftsKeptToast,
  publishedLabel,
  atLimitPublishToast,
  archivedNotice,
  CHANNEL_LABEL,
  DELETE_PAGE_NOTE,
  deletePageWarning,
  DEMOTE_NOTE,
  DEMOTED_TOAST,
  demoteDeadline,
  effectiveStatus,
  expiredDraftNotice,
  formatBytes,
  formatTimestamp,
  formatUpdatedAt,
  FIRST_VERSION_NOTE,
  PRO_VERSIONS_LINE,
  restoreWarning,
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

test("cards point at the detail route by the page's id, never its name (D2)", () => {
  const id = "0b8e6f5e-1c2d-4e3f-8a9b-0c1d2e3f4a5b";
  assert.equal(siteHref(id), `/site/${id}`);
});

test("a timestamp is pinned to UTC with the time, so two versions on one day read apart", () => {
  assert.equal(formatTimestamp(new Date("2026-10-03T14:20:00.000Z")), "3 Oct 2026, 14:20 UTC");
  assert.equal(formatTimestamp(new Date("2026-01-01T00:05:00.000Z")), "1 Jan 2026, 00:05 UTC");
});

test("every publish channel has a label, and the version copy is the PRD's", () => {
  for (const channel of PUBLISH_CHANNELS) assert.ok(CHANNEL_LABEL[channel], channel);
  assert.deepEqual(
    [CHANNEL_LABEL.web, CHANNEL_LABEL.studio, CHANNEL_LABEL.api],
    ["Web", "Studio", "API"],
  );
  assert.equal(
    FIRST_VERSION_NOTE,
    "This is the first version. Replace it and the old one stays here for undo.",
  );
  assert.equal(PRO_VERSIONS_LINE, `Keep ${limitsFor("premium").previousVersions} versions with Pro`);
  assert.match(restoreWarning("3 Oct 2026, 14:20 UTC"), /^The version from 3 Oct 2026, 14:20 UTC goes live/);
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

test("the demote copy states the FRESH clock from the constant, before and after", () => {
  assert.equal(DEMOTE_NOTE, `This page gets a ${DRAFT_TTL_DAYS}-day countdown again.`);
  assert.equal(
    demoteDeadline(new Date("2026-10-10T09:00:00.000Z")),
    "It expires on 10 Oct 2026 unless you keep it again.",
  );
  assert.equal(DEMOTED_TOAST, `Made draft · ${DRAFT_TTL_DAYS} days left`);
});

test("the delete warning is PRD §11's, and promises a hold only for a chosen name", () => {
  assert.equal(NAME_HOLD_PERIOD, "12 months", `${NAME_HOLD_DAYS} days, in the PRD's unit`);
  assert.equal(
    deletePageWarning(null),
    `The link stops working within about 2 minutes. You can download the files for ${DRAFT_GRACE_DAYS} days.`,
  );
  assert.equal(
    deletePageWarning("recipe-notes"),
    `The link stops working within about 2 minutes. You can download the files for ${DRAFT_GRACE_DAYS} days. The name recipe-notes stays reserved for you for 12 months.`,
  );
  assert.match(DELETE_PAGE_NOTE, new RegExp(`for ${DRAFT_GRACE_DAYS} days\\.$`));
  assert.equal(
    archivedNotice(new Date("2026-10-04T12:00:00.000Z"), new Date("2026-11-03T12:00:00.000Z")),
    "Deleted on 4 Oct 2026. You can download it until 3 Nov 2026.",
  );
  assert.equal(archivedNotice(new Date("2026-10-04T12:00:00.000Z"), null), "Deleted on 4 Oct 2026.");
});

test("the name section's words are PRD §5.4's, holds said only for a chosen name", () => {
  assert.equal(
    renameWarning("old-name.kept.host", true),
    "The old link old-name.kept.host stops working within about 2 minutes. Nobody else can take that name for 12 months.",
  );
  assert.equal(
    renameWarning("k3n8vq2p.kept.host", false),
    "The old link k3n8vq2p.kept.host stops working within about 2 minutes.",
  );
  assert.equal(DRAFT_NAME_NOTE, "Keep this page to give it a name. Drafts get a generated one.");
  assert.equal(namesUsed(2, limitsFor("free").chosenNames), `Names · 2 of ${limitsFor("free").chosenNames} used`);
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

test("a draft's published date is pinned to UTC with no year; the full stamp is its tooltip", () => {
  const at = new Date("2026-10-03T23:30:00Z");
  assert.equal(publishedLabel(at), "Published 3 Oct");
  // Pinned, so a reader east of UTC does not see the 4th on the server's 3rd.
  assert.equal(publishedLabel(new Date("2026-12-31T23:59:59Z")), "Published 31 Dec");
  assert.equal(formatTimestamp(at), "3 Oct 2026, 23:30 UTC");
});

test("the drafts filters: expiring is the warning chip's own rule, expired is a clock that has run out", () => {
  const now = new Date("2026-10-04T12:00:00Z");
  const at = (ms: number) => new Date(now.getTime() + ms);
  const fresh = at(5 * DAY);
  const urgent = at(DRAFT_URGENT_HOURS * HOUR);
  const expired = at(-HOUR);

  assert.deepEqual(
    [fresh, urgent, expired].map((expiresAt) => draftMatchesFilter(expiresAt, "all", now)),
    [true, true, true],
  );
  assert.deepEqual(
    [fresh, urgent, expired].map((expiresAt) => draftMatchesFilter(expiresAt, "expiring", now)),
    [false, true, false],
    "expiring soon = isDraftUrgent: inside the last DRAFT_URGENT_HOURS, not yet expired",
  );
  assert.deepEqual(
    [fresh, urgent, expired].map((expiresAt) => draftMatchesFilter(expiresAt, "expired", now)),
    [false, false, true],
  );
  assert.equal(draftMatchesFilter(now, "expired", now), true, "at expires_at it has expired");
});

test("bulk keep is all or nothing within the free slots, in one sentence for the bar and the server", () => {
  const { keptPages } = limitsFor("free");
  assert.equal(bulkKeepRefusal(3, 3, keptPages), null);
  assert.equal(bulkKeepRefusal(0, 0, keptPages), null);
  assert.equal(bulkKeepRefusal(4, 3, keptPages), "You can keep 3 more — select 3 or fewer.");
  assert.equal(
    bulkKeepRefusal(1, 0, keptPages),
    `You're keeping ${keptPages} of ${keptPages} — swap drafts in one at a time.`,
  );
});

test("deleting drafts says it goes offline now, and counts in words", () => {
  assert.equal(deleteDraftsTitle(1), "Delete this draft?");
  assert.equal(deleteDraftsNote(1), "It goes offline now.");
  assert.equal(deleteDraftsTitle(12), "Delete 12 drafts?");
  assert.equal(deleteDraftsNote(12), "They go offline now.");
  assert.equal(draftsDeletedToast(1), "Draft deleted.");
  assert.equal(draftsDeletedToast(12), "Deleted 12 drafts.");
  assert.equal(draftsKeptToast(1), KEPT_TOAST);
  assert.equal(draftsKeptToast(3), "Kept 3 drafts. They're permanent now.");
  assert.equal(
    bulkFailedToast(2, "deleted", "kept could not take this page offline."),
    "2 couldn't be deleted — kept could not take this page offline.",
  );
});
