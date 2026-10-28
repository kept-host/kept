/**
 * E10 task 005 — `badgeDataFor`, the one builder of the manifest's `badge`
 * (D3, D4, Q3, Q6, Q12, Q19). Pure: no store is touched. Real code, no mocks.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { badgeDataSchema } from "@kept/shared";

import { mayUseMinimalBadge } from "../plans/badge";

import { badgeDataFor, type BadgeRow } from "./badge-data";

/** A kept page of a free owner with no handle, no model and no README. */
const KEPT: BadgeRow = {
  expiresAt: null,
  model: null,
  showMadeWith: true,
  readme: null,
  allowRemix: null,
  handle: null,
  referralCode: "a1b2c3d4",
  badgeStyle: "standard",
  plan: "free",
};

const kept = (patch: Partial<BadgeRow>) => badgeDataFor({ ...KEPT, ...patch });

test("a draft wears the draft badge and nothing else — owner, model and ref never reach it (D4)", () => {
  const draft = kept({
    expiresAt: new Date(),
    model: "Claude",
    readme: "# notes",
    allowRemix: true,
    handle: "arun",
    badgeStyle: "minimal",
    plan: "premium",
  });
  assert.deepEqual(draft, { variant: "draft", style: "standard" });
});

test("an anonymous draft gets no refCode (edge case 9)", () => {
  const anonymous = badgeDataFor({ ...KEPT, expiresAt: new Date(), referralCode: null, badgeStyle: null, plan: null });
  assert.deepEqual(anonymous, { variant: "draft", style: "standard" });
});

test("a kept page credits its owner by the permanent code when there is no handle (Q3)", () => {
  assert.deepEqual(kept({}), { variant: "kept", style: "standard", refCode: "a1b2c3d4" });
});

test("with a handle, the handle is the refCode and is shown (Q3, Q13)", () => {
  assert.deepEqual(kept({ handle: "arun" }), { variant: "kept", style: "standard", refCode: "arun", handle: "arun" });
});

test("model: shown only while “Made with” is on; remix follows the default rule (Q12)", () => {
  assert.deepEqual(kept({ model: "Claude" }), {
    variant: "kept",
    style: "standard",
    model: "Claude",
    remix: true,
    refCode: "a1b2c3d4",
  });
  // Hiding the model does not change whether the page may be remixed.
  assert.deepEqual(kept({ model: "Claude", showMadeWith: false }), {
    variant: "kept",
    style: "standard",
    remix: true,
    refCode: "a1b2c3d4",
  });
  assert.equal(kept({ model: "Claude", allowRemix: false }).remix, undefined, "the owner's no wins");
  assert.equal(kept({ allowRemix: true }).remix, true, "the owner's yes wins with no model");
  assert.equal(kept({ model: "   " }).model, undefined, "a blank model is no model");
});

test("readme: true only when the page has one (Q6)", () => {
  assert.equal(kept({ readme: "# How it was made" }).readme, true);
  assert.equal(kept({ readme: "  \n" }).readme, undefined);
  assert.equal(kept({ readme: null }).readme, undefined);
});

test("minimal only for a Pro profile that chose it; otherwise standard (Q19)", () => {
  assert.equal(mayUseMinimalBadge("premium"), true);
  assert.equal(mayUseMinimalBadge("free"), false);
  assert.equal(kept({ badgeStyle: "minimal", plan: "premium" }).style, "minimal");
  assert.equal(kept({ badgeStyle: "minimal", plan: "free" }).style, "standard", "a lapsed Pro falls back");
  assert.equal(kept({ badgeStyle: "standard", plan: "premium" }).style, "standard");
});

test("a kept row with no owner (an anomaly) still gets a kept badge, without owner fields", () => {
  assert.deepEqual(badgeDataFor({ ...KEPT, referralCode: null, badgeStyle: null, plan: null }), {
    variant: "kept",
    style: "standard",
  });
});

test("every badge it builds parses as the manifest's schema", () => {
  for (const row of [
    kept({}),
    kept({ handle: "arun", model: "Claude", readme: "x", badgeStyle: "minimal", plan: "premium" }),
    kept({ expiresAt: new Date() }),
  ]) {
    assert.deepEqual(badgeDataSchema.strict().parse(row), row);
  }
});
