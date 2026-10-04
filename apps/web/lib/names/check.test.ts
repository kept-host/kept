/**
 * The name check — PRD §5.4's precedence on both plans (AC16, DB half), the
 * quota (AC20) and the rolling-24 h limit (AC21) as the check reports them, the
 * chosen-name count every surface reuses, the in-process limiter, and the field
 * copy. E06 task 006.
 *
 * NO MOCKS: real accounts, pages, holds and `name_events` on the dev Neon
 * branch. The limiter's clock is a real parameter of the real function.
 * Every limit is read from `limitsFor` / `RENAMES_PER_DAY` — never a literal.
 *
 * SKIPS the database drills when `DATABASE_URL` is absent (fork-PR CI).
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import {
  NAME_CHECK_STATUSES,
  PLANS,
  RENAMES_PER_DAY,
  limitsFor,
  nameCheckResultSchema,
  type NameCheckResult,
} from "@kept/shared";
import { config } from "dotenv";

import { closeDb } from "../db";
import { SiteNotFoundError } from "../sites/keep";
import { NamesDrill } from "../testing/names-drill";

import { NAME_CHECKS_PER_MINUTE, allowNameCheck, checkName, chosenNameCount } from "./check";
import { nameStatusMessage } from "./messages";

config({ path: ".env.local", quiet: true });

const skip = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const drill = new NamesDrill("e06-006-ck");

after(async () => {
  if (skip) return;
  await drill.cleanup();
  await closeDb();
});

for (const plan of PLANS) {
  describe(`AC16 (DB half) on ${plan}`, () => {
    test("available — a fresh name for a generated page with room", { skip }, async () => {
      const me = await drill.profile(plan);
      const page = await drill.site({ ownerId: me });
      assert.deepEqual(await checkName(drill.name(), me, page.id), { status: "available" });
    });

    test("taken — another page's active name", { skip }, async () => {
      const me = await drill.profile(plan);
      const someone = await drill.profile();
      const page = await drill.site({ ownerId: me });
      const theirs = await drill.site({ ownerId: someone });
      assert.deepEqual(await checkName(theirs.slug, me, page.id), { status: "taken" });
    });

    test("taken — a name held for someone else, never revealed as a hold", { skip }, async () => {
      const me = await drill.profile(plan);
      const someone = await drill.profile();
      const page = await drill.site({ ownerId: me });
      const held = drill.name();
      await drill.hold(held, someone, new Date(Date.now() + MINUTE_MS));
      assert.deepEqual(await checkName(held, me, page.id), { status: "taken" });
    });

    test("held_for_you — a name held for me", { skip }, async () => {
      const me = await drill.profile(plan);
      const page = await drill.site({ ownerId: me });
      const mine = drill.name();
      await drill.hold(mine, me, new Date(Date.now() + MINUTE_MS));
      assert.deepEqual(await checkName(mine, me, page.id), { status: "held_for_you" });
    });

    test("quota — a generated page when the plan's chosen names are all in use", { skip }, async () => {
      const me = await drill.profile(plan);
      const quota = limitsFor(plan).chosenNames;
      await drill.sites(quota, { ownerId: me, nameKind: "chosen" });
      const page = await drill.site({ ownerId: me });
      assert.deepEqual(await checkName(drill.name(), me, page.id), {
        status: "quota",
        count: quota,
        quota,
      });
    });

    test("rate_limited — RENAMES_PER_DAY renames in the last 24 h", { skip }, async () => {
      const me = await drill.profile(plan);
      const page = await drill.site({ ownerId: me });
      await drill.renames(me, page.id, RENAMES_PER_DAY);
      assert.deepEqual(await checkName(drill.name(), me, page.id), {
        status: "rate_limited",
        count: RENAMES_PER_DAY,
      });
    });

    test("too_short carries the plan's own minimum", { skip }, async () => {
      const me = await drill.profile(plan);
      const page = await drill.site({ ownerId: me });
      assert.deepEqual(await checkName("abc", me, page.id), {
        status: "too_short",
        min: limitsFor(plan).nameMinLength,
      });
    });
  });
}

test("precedence: taken outranks quota and rate_limited; quota outranks rate_limited", { skip }, async () => {
  const me = await drill.profile();
  const someone = await drill.profile();
  await drill.sites(limitsFor("free").chosenNames, { ownerId: me, nameKind: "chosen" });
  const page = await drill.site({ ownerId: me });
  await drill.renames(me, page.id, RENAMES_PER_DAY);
  const theirs = await drill.site({ ownerId: someone });

  assert.equal((await checkName(theirs.slug, me, page.id)).status, "taken");
  assert.equal((await checkName(drill.name(), me, page.id)).status, "quota");
  // The pure rule outranks all of them, reserved first (AC22).
  assert.equal((await checkName("docs", me, page.id)).status, "reserved");
  assert.equal((await checkName("Not A Name", me, page.id)).status, "invalid");
});

test("a held name taken back still needs room: held_for_you yields to quota (edge case 5)", { skip }, async () => {
  const me = await drill.profile();
  await drill.sites(limitsFor("free").chosenNames, { ownerId: me, nameKind: "chosen" });
  const page = await drill.site({ ownerId: me });
  const mine = drill.name();
  await drill.hold(mine, me, new Date(Date.now() + MINUTE_MS));
  assert.equal((await checkName(mine, me, page.id)).status, "quota");
});

test("AC20 (check half): renaming a page that already has a chosen name never reads quota", { skip }, async () => {
  const me = await drill.profile();
  const quota = limitsFor("free").chosenNames;
  const [named] = await drill.sites(quota, { ownerId: me, nameKind: "chosen" });
  assert.ok(named);
  assert.deepEqual(await checkName(drill.name(), me, named.id), { status: "available" });
});

test("AC21 (check half): renames older than 24 h no longer count", { skip }, async () => {
  const me = await drill.profile();
  const page = await drill.site({ ownerId: me });
  await drill.renames(me, page.id, RENAMES_PER_DAY, new Date(Date.now() - DAY_MS - MINUTE_MS));
  await drill.renames(me, page.id, RENAMES_PER_DAY - 1);
  assert.deepEqual(await checkName(drill.name(), me, page.id), { status: "available" });
});

test("pro_length on free, ok on premium — the plan comes from the owner's row", { skip }, async () => {
  const free = await drill.profile("free");
  const premium = await drill.profile("premium");
  const freePage = await drill.site({ ownerId: free });
  const premiumPage = await drill.site({ ownerId: premium });
  assert.deepEqual(await checkName("qz7x", free, freePage.id), { status: "pro_length" });
  assert.deepEqual(await checkName("qz7x", premium, premiumPage.id), { status: "available" });
});

test("the page's own current name reads available — renaming to it is a no-op", { skip }, async () => {
  const me = await drill.profile();
  const page = await drill.site({ ownerId: me });
  assert.deepEqual(await checkName(page.slug, me, page.id), { status: "available" });
});

test("another account's page, a missing page and an archived page are all not found", { skip }, async () => {
  const me = await drill.profile();
  const someone = await drill.profile();
  const theirs = await drill.site({ ownerId: someone });
  const archived = await drill.site({ ownerId: me, status: "archived" });
  for (const siteId of [theirs.id, archived.id, crypto.randomUUID()]) {
    await assert.rejects(checkName(drill.name(), me, siteId), SiteNotFoundError);
  }
});

test("chosenNameCount: chosen names on non-final pages — a demoted page keeps counting (D3)", { skip }, async () => {
  const me = await drill.profile();
  await drill.site({ ownerId: me, nameKind: "chosen" });
  await drill.site({ ownerId: me, nameKind: "chosen", kept: false }); // demoted: a draft now
  await drill.site({ ownerId: me, nameKind: "chosen", status: "quarantined" });
  await drill.site({ ownerId: me, nameKind: "chosen", status: "archived" });
  await drill.site({ ownerId: me, nameKind: "chosen", status: "removed" });
  await drill.site({ ownerId: me, nameKind: "generated" });
  assert.equal(await chosenNameCount(me), 3);
});

describe("allowNameCheck — the in-process per-minute guard (epic Risk 12)", () => {
  const PER_MINUTE = NAME_CHECKS_PER_MINUTE;

  test("allows a minute's budget, refuses the next, and resets with the window", () => {
    const me = crypto.randomUUID();
    const start = Date.now();
    for (let i = 0; i < PER_MINUTE; i++) {
      assert.equal(allowNameCheck(me, start + i), true, `check ${i + 1}`);
    }
    assert.equal(allowNameCheck(me, start + PER_MINUTE), false, "one over the budget");
    assert.equal(allowNameCheck(me, start + MINUTE_MS), true, "a new window");
  });

  test("one account's budget is not another's", () => {
    const busy = crypto.randomUUID();
    const quiet = crypto.randomUUID();
    const start = Date.now();
    for (let i = 0; i <= PER_MINUTE; i++) allowNameCheck(busy, start);
    assert.equal(allowNameCheck(busy, start), false);
    assert.equal(allowNameCheck(quiet, start), true);
  });
});

describe("the field copy (PRD §5.4) — one sentence per status, every number interpolated", () => {
  const samples: NameCheckResult[] = [
    { status: "invalid" },
    { status: "too_short", min: 7 },
    { status: "pro_length" },
    { status: "reserved" },
    { status: "inappropriate" },
    { status: "held_for_you" },
    { status: "taken" },
    { status: "quota", count: 11, quota: 13 },
    { status: "rate_limited", count: 17 },
    { status: "available" },
  ];

  test("every status the check can give has a sample here, and each parses", () => {
    assert.deepEqual(new Set(samples.map((s) => s.status)), new Set(NAME_CHECK_STATUSES));
    for (const sample of samples) nameCheckResultSchema.parse(sample);
  });

  test("the numbers in a sentence are the result's, never typed into the copy", () => {
    const say = (result: NameCheckResult, name = "my-page") =>
      nameStatusMessage(result, name, ".kept.example");
    assert.equal(say({ status: "too_short", min: 7 }), "Names need at least 7 characters.");
    assert.equal(say({ status: "pro_length" }, "abcd"), "4-letter names come with Pro.");
    assert.equal(
      say({ status: "quota", count: 11, quota: 13 }),
      "You've used 11 of 13 names. Delete a named page to free one.",
    );
    assert.equal(
      say({ status: "rate_limited", count: 17 }),
      "You've changed names 17 times today. Try again tomorrow.",
    );
    assert.equal(say({ status: "available" }), "my-page.kept.example is free");
    assert.equal(say({ status: "taken" }), "That name is taken.");
  });
});
