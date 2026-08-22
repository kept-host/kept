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

import { SITE_STATUSES, type SiteStatus } from "@kept/shared";

import {
  effectiveStatus,
  formatBytes,
  formatUpdatedAt,
  isManagementRestricted,
  managementRefusal,
  siteHref,
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
