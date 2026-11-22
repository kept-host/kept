/**
 * The one namespace check (D5) and the mint that asks it (AC23) — E06 task 006.
 *
 * NO MOCKS. Real `sites` and `name_holds` rows on the dev Neon branch. AC23's
 * forced generator is a real function passed through `withMintedSlug`'s own
 * `candidates` parameter — the seam the production mint runs through with
 * `mintSlugCandidate` — not a stub of anything.
 *
 * SKIPS when `DATABASE_URL` is absent (fork-PR CI). Run locally:
 *
 *   pnpm --filter @kept/web test:unit
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { config } from "dotenv";

import { closeDb } from "../db";
import { SlugUnavailableError, withMintedSlug } from "../db/queries/publish";
import { NamesDrill } from "../testing/names-drill";

import { isNameAvailable } from "./availability";

config({ path: ".env.local", quiet: true });

const skip = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const MINUTE_MS = 60_000;
const drill = new NamesDrill("e06-006-av");

after(async () => {
  if (skip) return;
  await drill.cleanup();
  await closeDb();
});

test("an active page's name is taken — for its owner and for everyone else", { skip }, async () => {
  const owner = await drill.profile();
  const stranger = await drill.profile();
  const page = await drill.site({ ownerId: owner });

  assert.equal(await isNameAvailable(page.slug, owner), "taken");
  assert.equal(await isNameAvailable(page.slug, stranger), "taken");
  assert.equal(await isNameAvailable(page.slug, null), "taken");
});

test("an archived or removed page does not claim its name (the partial index's rule)", { skip }, async () => {
  const owner = await drill.profile();
  for (const status of ["archived", "removed"] as const) {
    const page = await drill.site({ ownerId: owner, status });
    assert.equal(await isNameAvailable(page.slug, null), "available", status);
  }
  // …while every other status still does, flagged pages included.
  for (const status of ["quarantined", "under_review", "expired"] as const) {
    const page = await drill.site({ ownerId: owner, status });
    assert.equal(await isNameAvailable(page.slug, null), "taken", status);
  }
});

test("an unexpired hold is held_for_you for its owner and plain taken for anyone else (edge case 4)", { skip }, async () => {
  const owner = await drill.profile();
  const stranger = await drill.profile();
  const held = drill.name();
  await drill.hold(held, owner, new Date(Date.now() + MINUTE_MS));

  assert.equal(await isNameAvailable(held, owner), "held_for_you");
  // The hold is never revealed: a stranger reads exactly what an active page reads.
  assert.equal(await isNameAvailable(held, stranger), "taken");
  assert.equal(await isNameAvailable(held, null), "taken");
});

test("a hold with no owner (account deleted, D16) is taken for everybody", { skip }, async () => {
  const someone = await drill.profile();
  const orphaned = drill.name();
  await drill.hold(orphaned, null, new Date(Date.now() + MINUTE_MS));

  assert.equal(await isNameAvailable(orphaned, someone), "taken");
  assert.equal(await isNameAvailable(orphaned, null), "taken");
});

test("an expired hold is ignored — no sweep needed", { skip }, async () => {
  const owner = await drill.profile();
  const stranger = await drill.profile();
  const lapsed = drill.name();
  await drill.hold(lapsed, owner, new Date(Date.now() - MINUTE_MS));

  assert.equal(await isNameAvailable(lapsed, stranger), "available");
  assert.equal(await isNameAvailable(lapsed, owner), "available");
});

test("AC23: the mint skips a held name and an active name its generator emits first", { skip }, async () => {
  const owner = await drill.profile();
  const held = drill.name();
  await drill.hold(held, owner, new Date(Date.now() + MINUTE_MS));
  const active = await drill.site({ ownerId: owner });
  const fresh = drill.name();

  const emitted: string[] = [];
  const forced = [held, active.slug, fresh];
  const minted = await withMintedSlug(
    async (slug) => slug,
    () => {
      const next = forced[emitted.length];
      if (next === undefined) throw new Error("the forced generator ran dry");
      emitted.push(next);
      return next;
    },
  );

  assert.equal(minted, fresh, "the mint must hand out neither the held nor the active name");
  assert.notEqual(minted, held);
  assert.notEqual(minted, active.slug);
  assert.deepEqual(emitted, [held, active.slug, fresh], "each refused candidate was drawn, asked and skipped");
});

test("AC23: a generator that only ever emits a held name exhausts the bound, never inserts", { skip }, async () => {
  const owner = await drill.profile();
  const held = drill.name();
  await drill.hold(held, owner, new Date(Date.now() + MINUTE_MS));

  let attempts = 0;
  await assert.rejects(
    withMintedSlug(
      async () => {
        attempts += 1;
        return held;
      },
      () => held,
    ),
    SlugUnavailableError,
  );
  assert.equal(attempts, 0, "a held candidate must never reach the insert");
});

test("E10 D9: a current handle is held_for_you for its account and taken for everyone else; an old handle is taken for all (Q22)", { skip }, async () => {
  const { db } = await import("../db");
  const { handleRedirects, nameHolds, profiles } = await import("../db/schema");
  const { eq, sql } = await import("drizzle-orm");
  const owner = await drill.profile();
  const stranger = await drill.profile();
  const current = drill.name();
  const old = drill.name();
  await db.update(profiles).set({ handle: current }).where(eq(profiles.id, owner));
  await db.insert(handleRedirects).values({ oldHandle: old, profileId: owner });
  await db.insert(nameHolds).values({ name: old, userId: owner, reason: "renamed", heldUntil: sql`'infinity'::timestamptz` });

  assert.equal(await isNameAvailable(current, owner), "held_for_you");
  assert.equal(await isNameAvailable(current, stranger), "taken");
  assert.equal(await isNameAvailable(current, null), "taken");
  // The redirect row decides it before the hold could say `held_for_you`.
  assert.equal(await isNameAvailable(old, owner), "taken");
  assert.equal(await isNameAvailable(old, stranger), "taken");
});

test("an 'infinity' hold never expires (gt(held_until, now()) holds for it)", { skip }, async () => {
  const { db } = await import("../db");
  const { nameHolds } = await import("../db/schema");
  const { sql } = await import("drizzle-orm");
  const owner = await drill.profile();
  const forever = drill.name();
  await db.insert(nameHolds).values({ name: forever, userId: null, reason: "account_deleted", heldUntil: sql`'infinity'::timestamptz` });
  assert.equal(await isNameAvailable(forever, owner), "taken");
});
