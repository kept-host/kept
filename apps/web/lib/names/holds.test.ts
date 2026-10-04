/**
 * Name holds (D4) and E07's `releaseName` contract — E06 task 006.
 *
 * NO MOCKS: real rows on the dev Neon branch, the hold's deadline read back
 * from Postgres. `releaseName` has no E06 caller but this drill — E07's purge
 * job is its caller (edge case 7), and this is the contract it builds against.
 *
 * SKIPS when `DATABASE_URL` is absent (fork-PR CI).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { NAME_HOLD_DAYS } from "@kept/shared";
import { config } from "dotenv";

import { closeDb } from "../db";
import { NamesDrill } from "../testing/names-drill";

import { isNameAvailable } from "./availability";
import { holdName, releaseName } from "./holds";

config({ path: ".env.local", quiet: true });

const skip = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Clock slack between this process and Postgres's `now()`. */
const SLACK_MS = 5 * 60_000;
const drill = new NamesDrill("e06-006-hd");

after(async () => {
  if (skip) return;
  await drill.cleanup();
  await closeDb();
});

function assertHeldForAYear(heldUntil: Date, label: string) {
  const expected = Date.now() + NAME_HOLD_DAYS * MS_PER_DAY;
  assert.ok(
    Math.abs(heldUntil.getTime() - expected) < SLACK_MS,
    `${label}: held_until ${heldUntil.toISOString()} should be ~NAME_HOLD_DAYS from now`,
  );
}

test("holdName holds a name for NAME_HOLD_DAYS for its last owner", { skip }, async () => {
  const owner = await drill.profile();
  const page = await drill.site({ ownerId: owner, nameKind: "chosen", status: "archived" });

  await holdName(page.slug, owner, "deleted", page.id);

  const hold = await drill.holdOf(page.slug);
  assert.ok(hold, "a hold row must exist");
  assert.equal(hold.userId, owner);
  assert.equal(hold.siteId, page.id);
  assert.equal(hold.reason, "deleted");
  assertHeldForAYear(hold.heldUntil, "new hold");
  assert.equal(await isNameAvailable(page.slug, owner), "held_for_you");
});

test("a re-hold upserts: it extends, and the newest owner replaces a lapsed one", { skip }, async () => {
  const first = await drill.profile();
  const second = await drill.profile();
  const name = drill.name();
  // The first owner's hold has lapsed; the name was taken and is let go again.
  await drill.hold(name, first, new Date(Date.now() - 60_000));

  await holdName(name, second, "renamed");

  const hold = await drill.holdOf(name);
  assert.ok(hold);
  assert.equal(hold.userId, second, "the lapsed owner must not outlive the newer one");
  assert.equal(hold.reason, "renamed");
  assert.equal(hold.siteId, null);
  assertHeldForAYear(hold.heldUntil, "re-hold");
  assert.equal(await isNameAvailable(name, second), "held_for_you");
  assert.equal(await isNameAvailable(name, first), "taken");
});

test("a hold with no owner (account deletion, D16) is accepted", { skip }, async () => {
  const name = drill.name();
  await holdName(name, null, "account_deleted");
  const hold = await drill.holdOf(name);
  assert.ok(hold);
  assert.equal(hold.userId, null);
  assert.equal(hold.reason, "account_deleted");
});

test("releaseName: a chosen name gets a `purged` hold for its last owner (edge case 7)", { skip }, async () => {
  const owner = await drill.profile();
  const page = await drill.site({ ownerId: owner, nameKind: "chosen", status: "archived" });

  await releaseName(page.id);

  const hold = await drill.holdOf(page.slug);
  assert.ok(hold, "a purged chosen name must be held");
  assert.equal(hold.reason, "purged");
  assert.equal(hold.userId, owner);
  assert.equal(hold.siteId, page.id);
  assertHeldForAYear(hold.heldUntil, "purged hold");
});

test("releaseName: a generated name is simply gone — no hold", { skip }, async () => {
  const owner = await drill.profile();
  const page = await drill.site({ ownerId: owner, nameKind: "generated", status: "archived" });

  await releaseName(page.id);

  assert.equal(await drill.holdOf(page.slug), null);
  assert.equal(await isNameAvailable(page.slug, null), "available");
});
