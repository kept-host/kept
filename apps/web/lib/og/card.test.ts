import assert from "node:assert/strict";
import { test } from "node:test";

import { PAGE_TITLE_MAX_LENGTH } from "@kept/shared";

import { OG_TITLE_MAX_CHARS, clampOgTitle } from "./card";
import { ogCardPath, ogCardRevision } from "./card-url";

/**
 * The two pieces of the OG card that a render cannot check for you — E06 task
 * 010. The layout was settled by looking at rendered cards; the clamp and the
 * cache key were not, because both fail in ways an image looks fine with.
 */

test("a title that fits is returned untouched", () => {
  const title = "Anna's Reading List — Summer 2026";
  assert.equal(clampOgTitle(title), title);
});

test("a title exactly at the cap is not clamped", () => {
  const title = "a".repeat(OG_TITLE_MAX_CHARS);
  assert.equal(clampOgTitle(title), title);
});

test("a longer title is cut and marked as cut", () => {
  const clamped = clampOgTitle("b".repeat(OG_TITLE_MAX_CHARS + 40));
  assert.equal(Array.from(clamped).length, OG_TITLE_MAX_CHARS + 1);
  assert.ok(clamped.endsWith("…"), "a truncated headline must say so");
});

test("astral-plane characters are never cut through a surrogate pair", () => {
  // Every code point here is two UTF-16 units, so a naive `slice` would land
  // mid-pair and produce a replacement glyph on a permanent, cached image.
  const clamped = clampOgTitle("🌍".repeat(OG_TITLE_MAX_CHARS + 10));
  assert.ok(!clamped.includes("�"));
  assert.equal(Array.from(clamped).length, OG_TITLE_MAX_CHARS + 1);
});

test("the display cap is stricter than the storage cap", () => {
  // They are different questions and must stay different numbers: the shared
  // cap bounds what the row holds, this one bounds what fits on a card. A card
  // that assumed the storage cap was short enough would overflow.
  assert.ok(
    OG_TITLE_MAX_CHARS < PAGE_TITLE_MAX_LENGTH,
    "a stored title must always be clampable further for the card",
  );
});

test("the revision token moves when the bytes change", () => {
  const site = { id: "s", currentVersionId: "v1", expiresAt: null };
  assert.notEqual(ogCardRevision(site), ogCardRevision({ ...site, currentVersionId: "v2" }));
});

test("the revision token moves when a draft is kept", () => {
  // Keeping does not touch `current_version_id`, but it does flip the chip. A
  // key that ignored it would serve "DRAFT" under `immutable` for a year.
  const kept = { id: "s", currentVersionId: "v1", expiresAt: null };
  const draft = { ...kept, expiresAt: new Date("2026-09-01T00:00:00Z") };
  assert.notEqual(ogCardRevision(kept), ogCardRevision(draft));
});

test("a row with no current version still produces an unambiguous token", () => {
  assert.equal(
    ogCardRevision({ id: "s", currentVersionId: null, expiresAt: null }),
    "none-k",
  );
});

test("the card path is app-relative and carries the revision", () => {
  const path = ogCardPath({ id: "abc", currentVersionId: "v1", expiresAt: null });
  assert.equal(path, "/api/og/abc?v=v1-k");
});
