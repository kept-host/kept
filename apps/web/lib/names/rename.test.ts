/**
 * Rename — the transaction, the holds, the quota, the 24 h limit and the race.
 * E06 task 006: AC17 (server), AC19, AC20, AC21, AC24 (scenario), Bug 4 (the
 * rename half) and epic Verification 11.
 *
 * NO MOCKS. Real accounts, pages, holds and events on the dev Neon branch; a
 * successful rename writes a REAL manifest (R2 pointer + KV + purge) at the new
 * name, which `after` removes again. The old URL going dark and R2's page
 * objects staying put are asserted over the deployed edge by
 * `e2e/owner-rename-api.spec.ts` (AC18), which is the only place they can be.
 *
 * THE RACE (Verification 11) is driven, not argued: transaction A runs the real
 * `applyRename` and holds its transaction open; B runs the real `renameSite`;
 * the drill waits until Postgres shows B waiting on the advisory lock for the
 * contested name, and only then lets A commit. B must answer `name_taken`.
 *
 * SKIPS when `DATABASE_URL` is absent (fork-PR CI).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { RENAMES_PER_DAY, limitsFor, type StudioErrorCode } from "@kept/shared";
import { config } from "dotenv";
import { and, eq, sql } from "drizzle-orm";

import { closeDb, db } from "../db";
import { nameEvents } from "../db/schema";
import { StudioRefusal } from "../sites/studio-refusal";
import { pointerKey, removeManifest } from "../storage/manifest";
import { r2Store } from "../storage/r2";
import { NamesDrill } from "../testing/names-drill";

import { checkName, chosenNameCount } from "./check";
import { applyRename, renameSite } from "./rename";

config({ path: ".env.local", quiet: true });

const skip = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const MINUTE_MS = 60_000;
const drill = new NamesDrill("e06-006-rn");
/** Names a successful rename published to the edge — unwound in `after`. */
const published = new Set<string>();

after(async () => {
  if (skip) return;
  for (const name of published) {
    await removeManifest(name).catch(() => undefined);
  }
  await drill.cleanup();
  await closeDb();
});

/** A rename that is expected to land; its new name is tracked for teardown. */
async function rename(siteId: string, userId: string, name: string) {
  published.add(name);
  return renameSite(siteId, userId, name);
}

/** The refusal a rename must give, and nothing written for it. */
async function assertRefused(
  siteId: string,
  userId: string,
  name: string,
  code: StudioErrorCode,
): Promise<void> {
  const before = await drill.read(siteId);
  await assert.rejects(
    renameSite(siteId, userId, name),
    (err: unknown) => err instanceof StudioRefusal && err.code === code,
    `${name} must be refused with ${code}`,
  );
  assert.deepEqual(await drill.read(siteId), before, `${name}: a refusal writes nothing`);
  assert.equal(await r2Store().get(pointerKey(name)), null, `${name}: no pointer at a refused name`);
}

async function eventsFor(siteId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(nameEvents)
    .where(eq(nameEvents.siteId, siteId));
  return row?.count ?? 0;
}

test("AC17 (server): a draft is refused not_allowed_in_status, and so is a page under review", { skip }, async () => {
  const me = await drill.profile();
  const draft = await drill.site({ ownerId: me, kept: false });
  await assertRefused(draft.id, me, drill.name(), "not_allowed_in_status");

  const flagged = await drill.site({ ownerId: me, status: "quarantined" });
  await assertRefused(flagged.id, me, drill.name(), "not_allowed_in_status");
});

test("archived, removed, another account's and a missing page are all not_found", { skip }, async () => {
  const me = await drill.profile();
  const someone = await drill.profile();
  const archived = await drill.site({ ownerId: me, status: "archived" });
  const removed = await drill.site({ ownerId: me, status: "removed" });
  const theirs = await drill.site({ ownerId: someone });
  for (const page of [archived, removed, theirs]) {
    await assertRefused(page.id, me, drill.name(), "not_found");
  }
  await assert.rejects(
    renameSite(crypto.randomUUID(), me, drill.name()),
    (err: unknown) => err instanceof StudioRefusal && err.code === "not_found",
  );
});

test("the name rule refuses before anything is locked or written", { skip }, async () => {
  const me = await drill.profile();
  const page = await drill.site({ ownerId: me });
  const cases: [string, StudioErrorCode][] = [
    ["Not A Name", "name_invalid"],
    ["abc", "name_too_short"],
    ["qz7x", "name_pro_length"],
    ["explore", "name_reserved"],
    ["my-fuck-page", "name_inappropriate"],
  ];
  for (const [name, code] of cases) await assertRefused(page.id, me, name, code);
  assert.equal(await eventsFor(page.id), 0);
});

test("renaming a page to its own name is a no-op: no event, no clock moved", { skip }, async () => {
  const me = await drill.profile();
  const page = await drill.site({ ownerId: me });
  const before = await drill.read(page.id);
  const site = await renameSite(page.id, me, page.slug);
  assert.equal(site.slug, page.slug);
  assert.equal(site.nameKind, "generated");
  assert.deepEqual(await drill.read(page.id), before);
  assert.equal(await eventsFor(page.id), 0);
});

test("AC19 + Bug 4: rename away a chosen name → held; others read taken, the owner takes it back and it counts again", { skip }, async () => {
  const owner = await drill.profile();
  const stranger = await drill.profile();
  const x = drill.name();
  const y = drill.name();
  const named = await drill.site({ ownerId: owner, slug: x, nameKind: "chosen" });
  const plain = await drill.site({ ownerId: owner });
  const strangersPage = await drill.site({ ownerId: stranger });
  const before = await drill.read(named.id);

  // Bug 4 needs a measurable gap: `updated_at` has millisecond resolution.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const renamed = await rename(named.id, owner, y);

  // The page moved, and says so.
  assert.equal(renamed.slug, y);
  assert.equal(renamed.nameKind, "chosen");
  assert.ok(renamed.liveUrl.startsWith(`https://${y}.`));
  const after = await drill.read(named.id);
  assert.equal(after.slug, y);
  // Bug 4 (rename half): the OG card's cache key is built on this column.
  assert.ok(
    after.updatedAt.getTime() > before.updatedAt.getTime(),
    "a rename must move sites.updated_at",
  );
  assert.equal(renamed.updatedAt, after.updatedAt.toISOString());
  assert.equal(await eventsFor(named.id), 1);
  // The new name is published at the edge's pointer.
  assert.notEqual(await r2Store().get(pointerKey(y)), null, "the new name must have a pointer");

  // The old chosen name is held for its last owner (D4).
  const hold = await drill.holdOf(x);
  assert.ok(hold, "renaming away a chosen name must hold it");
  assert.equal(hold.userId, owner);
  assert.equal(hold.reason, "renamed");
  assert.equal(hold.siteId, named.id);

  // Nobody else can have it, and nothing says why.
  assert.deepEqual(await checkName(x, stranger, strangersPage.id), { status: "taken" });
  await assertRefused(strangersPage.id, stranger, x, "name_taken");
  // Its owner reads it as theirs to take back (edge case 5).
  assert.deepEqual(await checkName(x, owner, plain.id), { status: "held_for_you" });

  // Taking it back onto a generated page: the hold is spent, and it counts again.
  const countBefore = await chosenNameCount(owner);
  const takenBack = await rename(plain.id, owner, x);
  assert.equal(takenBack.slug, x);
  assert.equal(takenBack.nameKind, "chosen");
  assert.equal(await drill.holdOf(x), null, "a name taken back is no longer held");
  assert.equal(await chosenNameCount(owner), countBefore + 1, "a name taken back counts again");
});

test("edge case 6: renaming back to the page's own previous chosen name is allowed", { skip }, async () => {
  const owner = await drill.profile();
  const first = drill.name();
  const second = drill.name();
  const page = await drill.site({ ownerId: owner, slug: first, nameKind: "chosen" });

  await rename(page.id, owner, second);
  assert.equal((await drill.holdOf(first))?.userId, owner);

  const back = await rename(page.id, owner, first);
  assert.equal(back.slug, first);
  assert.equal(await drill.holdOf(first), null, "the returning name's hold is spent");
  assert.equal((await drill.holdOf(second))?.userId, owner, "the name it left is held in turn");
});

test("AC20: a free account's next chosen name is name_quota; a chosen page renames without using one", { skip }, async () => {
  const me = await drill.profile("free");
  const quota = limitsFor("free").chosenNames;
  const named = await drill.sites(quota, { ownerId: me, nameKind: "chosen" });
  const plain = await drill.site({ ownerId: me });
  assert.equal(await chosenNameCount(me), quota);

  await assertRefused(plain.id, me, drill.name(), "name_quota");

  const [first] = named;
  assert.ok(first);
  const moved = await rename(first.id, me, drill.name());
  assert.equal(moved.nameKind, "chosen");
  assert.equal(await chosenNameCount(me), quota, "chosen → chosen must not consume quota");
});

test("AC21: the rename after RENAMES_PER_DAY in 24 h is rename_rate_limited", { skip }, async () => {
  const me = await drill.profile();
  const page = await drill.site({ ownerId: me });
  await drill.renames(me, page.id, RENAMES_PER_DAY);
  await assertRefused(page.id, me, drill.name(), "rename_rate_limited");
  assert.equal(await eventsFor(page.id), RENAMES_PER_DAY, "a refused rename records no event");
});

test("AC24: an archived row keeps name X; once its hold lapses another account renames to X", { skip }, async () => {
  const former = await drill.profile();
  const newcomer = await drill.profile();
  const x = drill.name();
  const archived = await drill.site({ ownerId: former, slug: x, nameKind: "chosen", status: "archived" });
  await drill.hold(x, former, new Date(Date.now() - MINUTE_MS));
  const page = await drill.site({ ownerId: newcomer });

  const renamed = await rename(page.id, newcomer, x);
  assert.equal(renamed.slug, x);
  // Two rows carry the slug — the archived one for history, the live one for
  // serving — which only the partial `sites_slug_key` allows.
  assert.equal((await drill.read(archived.id)).slug, x);
  assert.equal((await drill.read(page.id)).slug, x);
});

/** Wait until some backend is blocked on the advisory lock for `name`. */
async function waitUntilBlockedOn(name: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    const [row] = await db.execute<{ waiting: number }>(sql`
      select count(*)::int as waiting
        from pg_locks
       where locktype = 'advisory'
         and not granted
         and objid::bigint = (hashtext(${`kept-name:${name}`})::bigint & 4294967295)
    `);
    if ((row?.waiting ?? 0) > 0) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`No transaction blocked on the lock for "${name}" within ${timeoutMs} ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("Verification 11: a rename-to cannot beat a concurrent rename-away's hold (the race, on real Postgres)", { skip }, async () => {
  const a = await drill.profile();
  const b = await drill.profile();
  const x = drill.name();
  const y = drill.name();
  const pageA = await drill.site({ ownerId: a, slug: x, nameKind: "chosen" });
  const pageB = await drill.site({ ownerId: b });
  const pageBBefore = await drill.read(pageB.id);

  let letACommit!: () => void;
  const aMayCommit = new Promise<void>((resolve) => (letACommit = resolve));
  let signalLocked!: () => void;
  const aHoldsLocks = new Promise<void>((resolve) => (signalLocked = resolve));

  // T1 — A renames X → Y and holds X, then keeps the transaction OPEN.
  const t1 = db.transaction(async (tx) => {
    await applyRename(tx, pageA.id, a, y);
    signalLocked();
    await aMayCommit;
  });

  let t2: Promise<unknown> | undefined;
  try {
    await aHoldsLocks;
    // T2 — B renames to X while A's hold is uncommitted. It must block on X's lock.
    published.add(x);
    t2 = renameSite(pageB.id, b, x).then(
      () => null,
      (err: unknown) => err,
    );
    await waitUntilBlockedOn(x, 15_000);
  } finally {
    letACommit();
  }
  await t1;

  const outcome = await t2;
  assert.ok(
    outcome instanceof StudioRefusal && outcome.code === "name_taken",
    `B must lose with name_taken, got ${outcome instanceof Error ? outcome.message : String(outcome)}`,
  );
  // A's side landed; B's page is exactly as it was.
  assert.equal((await drill.read(pageA.id)).slug, y);
  assert.equal((await drill.holdOf(x))?.userId, a);
  assert.deepEqual(await drill.read(pageB.id), pageBBefore);
  const [bEvents] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(nameEvents)
    .where(and(eq(nameEvents.siteId, pageB.id), eq(nameEvents.userId, b)));
  assert.equal(bEvents?.count ?? 0, 0);
});
