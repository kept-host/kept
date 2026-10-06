/**
 * The owner-route drills — E05 task 010.
 *
 * NO MOCKS (project rule). Every assertion below runs `keepOwnedSite`,
 * `demoteOwnedSite` and `swapOwnedSites` — the exact functions the three
 * `route.ts` files delegate to — against the real dev Neon branch: real `user`,
 * `profiles` and `sites` rows, real transactions, real row locks. The only
 * thing the route files add on top is the session lookup, which `next/headers`
 * makes uncallable outside a Next request scope and which
 * `e2e/owner-sites-api.spec.ts` covers over the wire instead.
 *
 * THREE PROPERTIES ARE LOAD-BEARING HERE and are asserted byte for byte rather
 * than by status code alone:
 *
 *   1. A site that does not exist, a site owned by somebody else and an id that
 *      is not a uuid produce the IDENTICAL body. "You don't own this" is an
 *      existence oracle over other people's pages.
 *   2. Being at the plan's kept limit is `409 at_kept_limit` on the OWNER keep
 *      (E06 task 004, PRD §10.2): the page is already an owned draft, so there
 *      is nothing for the cap to degrade into. Nothing is written.
 *   3. Every refusal is the studio envelope `{ error: { code, message } }`
 *      (E06 task 005) — one typed-failure table, never a flat `PublishError`.
 *
 * Drill accounts are `free`, so the cap is `limitsFor("free").keptPages` (D1) —
 * never a literal. Cap-filling rows are seeded in ONE multi-row insert: real
 * rows, but not one round trip each.
 *
 * Nothing here touches R2, KV or the purge endpoint, because the module under
 * test must not either.
 *
 * The drills SKIP when `DATABASE_URL` is absent: CI runs `pnpm test` on fork PRs
 * with no cloud secrets. Run them locally with
 *
 *   pnpm --filter @kept/web test:unit
 *
 * Every row created here is deleted in `after`.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  DRAFT_GRACE_DAYS,
  DRAFT_TTL_DAYS,
  MAX_PAGE_BYTES,
  STUDIO_ERROR_CODES,
  demoteResultSchema,
  keepResultSchema,
  limitsFor,
  studioErrorSchema,
  swapResultSchema,
} from "@kept/shared";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The cap every drill account (`free`) is held to. */
const FREE_LIMIT = limitsFor("free").keptPages;

const createdSites = new Set<string>();
const createdProfiles = new Set<string>();

async function schema() {
  return import("../db/schema");
}

async function client() {
  const { db } = await import("../db/index");
  return db;
}

/** A brand-new account with zero kept pages. */
async function makeProfile(): Promise<string> {
  const db = await client();
  const { profiles, user } = await schema();
  const id = crypto.randomUUID();
  const email = `e05-010-${id}@kept.invalid`;
  await db.insert(user).values({ id, name: "E05-010 drill", email, emailVerified: true });
  await db.insert(profiles).values({ id, email, plan: "free" });
  createdProfiles.add(id);
  return id;
}

interface MakeSite {
  /** null → anonymous (has a token, has a clock). */
  ownerId?: string | null;
  /** Owned rows only: no clock → kept, clock → owned draft. */
  kept?: boolean;
}

/** One drill row's column values, tracked for teardown. Inserting is the caller's. */
function siteRow({ ownerId = null, kept = false }: MakeSite = {}) {
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DRAFT_TTL_DAYS * MS_PER_DAY);
  createdSites.add(id);
  return {
    id,
    slug: `e05-010-${id.slice(0, 12)}`,
    status: "live" as const,
    region: "auto" as const,
    ownerId,
    anonTokenHash: ownerId === null ? `e05-010-${id}` : null,
    publisherHash: "e05-010-drill",
    expiresAt: kept ? null : expiresAt,
    purgeAfter: kept ? null : new Date(expiresAt.getTime() + DRAFT_GRACE_DAYS * MS_PER_DAY),
    claimedAt: ownerId === null ? null : now,
    contentHash: "e05-010",
    sizeBytes: 128,
  };
}

async function makeSite(options: MakeSite = {}): Promise<{ id: string; slug: string }> {
  const db = await client();
  const { sites } = await schema();
  const row = siteRow(options);
  await db.insert(sites).values(row);
  return { id: row.id, slug: row.slug };
}

async function readSite(siteId: string) {
  const db = await client();
  const { sites } = await schema();
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select().from(sites).where(eq(sites.id, siteId));
  if (!row) throw new Error(`Drill row ${siteId} vanished.`);
  return row;
}

/**
 * The kept-ness predicate, asked of the database rather than of a result object
 * — through the module's own `isKeptCondition`, never a re-spelled WHERE clause
 * that could drift from the one the cap enforces.
 */
async function keptCount(profileId: string): Promise<number> {
  const db = await client();
  const { sites } = await schema();
  const { sql } = await import("drizzle-orm");
  const { isKeptCondition } = await import("./keep");
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sites)
    .where(isKeptCondition(profileId));
  return row?.count ?? 0;
}

/** `n` kept pages against one profile, in ONE insert — the way the cap drills need them. */
async function fillKept(profileId: string, n: number): Promise<{ id: string; slug: string }[]> {
  const db = await client();
  const { sites } = await schema();
  const rows = Array.from({ length: n }, () => siteRow({ ownerId: profileId, kept: true }));
  if (rows.length > 0) await db.insert(sites).values(rows);
  return rows.map(({ id, slug }) => ({ id, slug }));
}

/** A `timestamp` column the drill has just asserted must be set. */
function stamp(value: Date | null): Date {
  if (!value) throw new Error("Expected a timestamp, got null.");
  return value;
}

after(async () => {
  if (skipLive) return;
  const db = await client();
  const { profiles, sites, user } = await schema();
  const { inArray } = await import("drizzle-orm");

  if (createdSites.size > 0) {
    await db.delete(sites).where(inArray(sites.id, [...createdSites]));
  }
  if (createdProfiles.size > 0) {
    // `profiles.id` FKs `user.id` with `on delete cascade`, so one delete does both.
    await db.delete(profiles).where(inArray(profiles.id, [...createdProfiles]));
    await db.delete(user).where(inArray(user.id, [...createdProfiles]));
  }
  await db.$client.end();
});

// ── POST /api/sites/:id/keep ────────────────────────────────────────────────

test(
  "keep, under cap: an owned draft becomes kept and the response parses as a KeepResult",
  { skip: skipLive },
  async () => {
    const { keepOwnedSite } = await import("./owner-routes");
    const profileId = await makeProfile();
    const site = await makeSite({ ownerId: profileId });

    const outcome = await keepOwnedSite(site.id, profileId);

    assert.equal(outcome.ok, true);
    assert.equal(outcome.status, 200, "keeping is never anything but a success here");
    // The contract E06 is a client of, asserted rather than assumed.
    const body = keepResultSchema.parse(outcome.body);
    assert.equal(body.outcome, "kept");
    assert.equal(body.siteId, site.id);
    assert.equal(body.slug, site.slug);
    assert.deepEqual(body.quota, {
      limit: FREE_LIMIT,
      used: 1,
      remaining: FREE_LIMIT - 1,
    });

    const row = await readSite(site.id);
    assert.equal(row.expiresAt, null, "the clock is off");
    assert.equal(row.purgeAfter, null);
    assert.equal(row.status, "live", "keep never moves status");
    assert.equal(await keptCount(profileId), 1);
  },
);

test(
  "keep, at cap: 409 at_kept_limit in the studio envelope, and the owned draft is untouched",
  { skip: skipLive },
  async () => {
    const { keepOwnedSite } = await import("./owner-routes");
    const profileId = await makeProfile();
    await fillKept(profileId, FREE_LIMIT);
    const site = await makeSite({ ownerId: profileId });
    const before = await readSite(site.id);

    const outcome = await keepOwnedSite(site.id, profileId);

    assert.equal(outcome.ok, false, "the owner keep at the cap is a refusal (PRD §10.2)");
    assert.equal(outcome.status, 409);
    const { error } = studioErrorSchema.parse(outcome.body);
    assert.equal(error.code, "at_kept_limit");
    assert.ok(
      error.message.includes(String(FREE_LIMIT)),
      `the sentence names the plan's limit, from limitsFor: ${error.message}`,
    );

    assert.deepEqual(await readSite(site.id), before, "the countdown and every column are retained");
    assert.equal(
      await keptCount(profileId),
      FREE_LIMIT,
      "the account never exceeds the cap",
    );
  },
);

test(
  "keep is idempotent: keeping an already-kept page is a no-op success",
  { skip: skipLive },
  async () => {
    const { keepOwnedSite } = await import("./owner-routes");
    const profileId = await makeProfile();
    const site = await makeSite({ ownerId: profileId, kept: true });

    const outcome = await keepOwnedSite(site.id, profileId);

    assert.equal(outcome.ok, true);
    const body = keepResultSchema.parse(outcome.body);
    assert.equal(body.outcome, "kept");
    assert.deepEqual(body.quota, {
      limit: FREE_LIMIT,
      used: 1,
      remaining: FREE_LIMIT - 1,
    });
    assert.equal(await keptCount(profileId), 1, "no second slot was consumed");
  },
);

test(
  "keep does not open the anonymous door: an unclaimed draft is 404 to a signed-in stranger",
  { skip: skipLive },
  async () => {
    const { keepOwnedSite } = await import("./owner-routes");
    const profileId = await makeProfile();
    const anonymous = await makeSite();

    const outcome = await keepOwnedSite(anonymous.id, profileId);

    assert.equal(outcome.ok, false);
    assert.equal(
      outcome.status,
      404,
      "the anonymous→owned door is bearer-token authority behind /api/anon/, not this route",
    );
    const row = await readSite(anonymous.id);
    assert.equal(row.ownerId, null, "and nothing was written");
    assert.notEqual(row.anonTokenHash, null);
  },
);

// ── POST /api/sites/:id/demote ──────────────────────────────────────────────

test(
  "demote: a fresh clock, status still live, quota returned, no store touched",
  { skip: skipLive },
  async () => {
    const { demoteOwnedSite } = await import("./owner-routes");
    const profileId = await makeProfile();
    const kept = await fillKept(profileId, 2);
    const target = kept[0]!;
    const before = await readSite(target.id);
    assert.equal(before.expiresAt, null, "precondition: the page is kept");

    const outcome = await demoteOwnedSite(target.id, profileId);

    assert.equal(outcome.ok, true);
    assert.equal(outcome.status, 200);
    const body = demoteResultSchema.parse(outcome.body);
    assert.equal(body.siteId, target.id);
    assert.equal(body.slug, target.slug);
    assert.deepEqual(
      body.quota,
      { limit: FREE_LIMIT, used: 1, remaining: FREE_LIMIT - 1 },
      "the freed slot is visible without a second request",
    );

    const row = await readSite(target.id);
    const expiresAt = stamp(row.expiresAt);
    const purgeAfter = stamp(row.purgeAfter);
    assert.equal(
      Math.round((expiresAt.getTime() - Date.now()) / MS_PER_DAY),
      DRAFT_TTL_DAYS,
      "a fresh DRAFT_TTL_DAYS clock, from @kept/shared",
    );
    assert.equal(
      Math.round((purgeAfter.getTime() - expiresAt.getTime()) / MS_PER_DAY),
      DRAFT_GRACE_DAYS,
    );
    assert.equal(row.status, "live", "the page keeps serving at the same URL");
    assert.equal(row.ownerId, profileId, "a demoted page is an OWNED draft");
    assert.ok(row.claimedAt instanceof Date, "claimed_at survives a demote");
    assert.equal(row.slug, before.slug, "archive, don't delete — nothing is removed");
  },
);

test(
  "demoting a draft is 409 not_allowed_in_status with its clock untouched, and keeping it then has no cooldown",
  { skip: skipLive },
  async () => {
    const { demoteOwnedSite, keepOwnedSite } = await import("./owner-routes");
    const profileId = await makeProfile();
    const site = await makeSite({ ownerId: profileId });
    const before = await readSite(site.id);

    // Only a kept `live` page can be demoted: a second clock on a draft would
    // silently move its deadline.
    const first = await demoteOwnedSite(site.id, profileId);
    assert.equal(first.ok, false);
    assert.equal(first.status, 409);
    assert.equal(studioErrorSchema.parse(first.body).error.code, "not_allowed_in_status");
    assert.deepEqual(await readSite(site.id), before, "the draft's clock did not move");

    // Keep → immediate regret → demote → keep. No cooldown, by design.
    assert.equal((await keepOwnedSite(site.id, profileId)).ok, true);
    assert.equal((await demoteOwnedSite(site.id, profileId)).ok, true);
    assert.ok(stamp((await readSite(site.id)).expiresAt) instanceof Date);
    const kept = await keepOwnedSite(site.id, profileId);
    assert.equal(kept.ok, true);
    assert.equal(keepResultSchema.parse(kept.body).outcome, "kept");
    assert.equal((await readSite(site.id)).expiresAt, null, "kept again, immediately");
  },
);

// ── POST /api/sites/swap ────────────────────────────────────────────────────

test(
  "swap: one transaction, and the account lands at exactly its kept limit",
  { skip: skipLive },
  async () => {
    const { swapOwnedSites } = await import("./owner-routes");
    const profileId = await makeProfile();
    const kept = await fillKept(profileId, FREE_LIMIT);
    const incoming = await makeSite({ ownerId: profileId });
    const outgoing = kept[0]!;

    const outcome = await swapOwnedSites(
      { demote: outgoing.id, keep: incoming.id },
      profileId,
    );

    assert.equal(outcome.ok, true);
    assert.equal(outcome.status, 200);
    const body = swapResultSchema.parse(outcome.body);
    assert.equal(body.demoted.siteId, outgoing.id);
    assert.equal(body.kept.siteId, incoming.id);
    assert.equal(body.kept.outcome, "kept", "the swap freed the slot it then used");
    assert.deepEqual(
      body.demoted.quota,
      body.kept.quota,
      "both halves report the same post-swap quota",
    );
    assert.deepEqual(body.kept.quota, {
      limit: FREE_LIMIT,
      used: FREE_LIMIT,
      remaining: 0,
    });

    assert.equal(await keptCount(profileId), FREE_LIMIT, "never one short, never one over");
    assert.ok(
      stamp((await readSite(outgoing.id)).expiresAt) instanceof Date,
      "the demoted half is back on a clock",
    );
    assert.equal((await readSite(incoming.id)).expiresAt, null);
  },
);

test(
  "swap refuses demote === keep with a 400 — that is a caller bug, not a cap branch",
  { skip: skipLive },
  async () => {
    const { swapOwnedSites } = await import("./owner-routes");
    const profileId = await makeProfile();
    const kept = await fillKept(profileId, FREE_LIMIT);
    const site = kept[0]!;

    const outcome = await swapOwnedSites({ demote: site.id, keep: site.id }, profileId);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, 400);
    assert.equal(studioErrorSchema.parse(outcome.body).error.code, "invalid_request");
    assert.equal(
      await keptCount(profileId),
      FREE_LIMIT,
      "and nothing moved — the page is still kept",
    );
  },
);

test(
  "swap rejects a malformed body without touching the account",
  { skip: skipLive },
  async () => {
    const { swapOwnedSites } = await import("./owner-routes");
    const profileId = await makeProfile();
    await fillKept(profileId, 1);

    for (const raw of [null, {}, { demote: "not-a-uuid", keep: crypto.randomUUID() }, "x"]) {
      const outcome = await swapOwnedSites(raw, profileId);
      assert.equal(outcome.ok, false, `expected a refusal for ${JSON.stringify(raw)}`);
      assert.equal(outcome.status, 400);
    }
    assert.equal(await keptCount(profileId), 1);
  },
);

test(
  "swap is atomic across owners: a keep half the caller does not own leaves the demote half kept",
  { skip: skipLive },
  async () => {
    const { swapOwnedSites } = await import("./owner-routes");
    const mine = await makeProfile();
    const theirs = await makeProfile();
    const outgoing = (await fillKept(mine, 1))[0]!;
    const someoneElses = await makeSite({ ownerId: theirs });

    const outcome = await swapOwnedSites(
      { demote: outgoing.id, keep: someoneElses.id },
      mine,
    );

    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, 404);
    assert.equal(
      (await readSite(outgoing.id)).expiresAt,
      null,
      "the transaction rolled back — my page is still kept",
    );
    assert.equal(await keptCount(mine), 1);
  },
);

// ── The no-oracle property, across all three routes ─────────────────────────

test(
  "not-found and not-yours are byte-identical on every route, including a malformed id",
  { skip: skipLive },
  async () => {
    const { demoteOwnedSite, keepOwnedSite, swapOwnedSites } = await import("./owner-routes");
    const mine = await makeProfile();
    const theirs = await makeProfile();
    await fillKept(mine, 1);
    const theirKept = (await fillKept(theirs, 1))[0]!;
    const nonExistent = crypto.randomUUID();

    // Every reason a caller can invent, on every route that answers one.
    const ids = [theirKept.id, nonExistent, "not-a-uuid-at-all", ""];
    const bodies: string[] = [];

    for (const id of ids) {
      for (const call of [keepOwnedSite, demoteOwnedSite]) {
        const outcome = await call(id, mine);
        assert.equal(outcome.ok, false, `${id} must not resolve`);
        assert.equal(outcome.status, 404);
        bodies.push(JSON.stringify(outcome.body));
      }
    }

    // The swap route reaches the same refusal through `swapKept`.
    const swapped = await swapOwnedSites(
      { demote: theirKept.id, keep: crypto.randomUUID() },
      mine,
    );
    assert.equal(swapped.ok, false);
    assert.equal(swapped.status, 404);
    bodies.push(JSON.stringify(swapped.body));

    assert.equal(
      new Set(bodies).size,
      1,
      `all ${bodies.length} refusals must be one body — a difference is an existence oracle: ${[...new Set(bodies)].join(" | ")}`,
    );
    // …and that one body is the studio envelope's `not_found` (D17: never 403).
    assert.equal(studioErrorSchema.parse(JSON.parse(bodies[0]!)).error.code, "not_found");

    // And their page is untouched by any of it.
    assert.equal((await readSite(theirKept.id)).ownerId, theirs);
    assert.equal((await readSite(theirKept.id)).expiresAt, null);
  },
);

test(
  "the signed-out refusal is a 401 the route handlers return before any database work",
  { skip: skipLive },
  async () => {
    const { signedOut } = await import("./owner-routes");
    const refusal = signedOut();

    assert.equal(refusal.ok, false);
    assert.equal(refusal.status, 401);
    assert.deepEqual(studioErrorSchema.parse(refusal.body), refusal.body, "the envelope, too");
    // Distinguishable from the 404 by status, which is what a caller acts on:
    // "sign in again" and "that page is gone" are different remedies.
    const { ownerNotFound } = await import("./owner-routes");
    assert.notEqual(refusal.status, ownerNotFound().status);
  },
);

// ── The envelope (E06 task 005) ─────────────────────────────────────────────

test(
  "a typed refusal answers its own code at the table's status; anything else is a 500 that leaks nothing",
  { skip: skipLive },
  async () => {
    const { studioFailure } = await import("./owner-routes");
    const { StudioRefusal } = await import("./studio-refusal");

    // Every code in the closed enum has a status, and it is a 4xx/5xx — the
    // table is a `Record` over the enum, so this is the runtime half of that.
    for (const code of STUDIO_ERROR_CODES) {
      const failure = studioFailure(new StudioRefusal(code, `sentence for ${code}`), "drill");
      assert.equal(failure.ok, false);
      assert.ok(failure.status >= 400 && failure.status < 600, `${code} → ${failure.status}`);
      assert.deepEqual(failure.body, { error: { code, message: `sentence for ${code}` } });
    }

    // The detail is the LOG's: it never reaches the body.
    const withDetail = studioFailure(
      new StudioRefusal("internal_error", "Try again in a moment.", "R2 put: secret-ish detail"),
      "drill",
    );
    assert.equal(withDetail.status, 503);
    assert.equal(JSON.stringify(withDetail.body).includes("secret-ish"), false);

    const realError = console.error;
    console.error = () => undefined;
    try {
      const untyped = studioFailure(new Error("driver exploded: password=hunter2"), "keep");
      assert.equal(untyped.status, 500);
      assert.equal(studioErrorSchema.parse(untyped.body).error.code, "internal_error");
      assert.equal(JSON.stringify(untyped.body).includes("hunter2"), false);
    } finally {
      console.error = realError;
    }
  },
);

test(
  "pipeline refusals are translated at the boundary: an empty and an oversized page are invalid_file and file_too_large",
  { skip: skipLive },
  async () => {
    const { publishOwnedSite, replaceOwnedSite } = await import("./owner-routes");
    const profileId = await makeProfile();
    const site = await makeSite({ ownerId: profileId, kept: true });
    const publisher = { ip: "203.0.113.5", userAgent: "kept-e06-005-drill/1.0" };
    const oversized = `<!doctype html><title>x</title>${"a".repeat(MAX_PAGE_BYTES)}`;

    for (const [label, call] of [
      ["publish", (html: unknown) => publishOwnedSite({ html }, profileId, publisher)],
      ["replace", (html: unknown) => replaceOwnedSite(site.id, { html }, profileId)],
    ] as const) {
      const empty = await call("");
      assert.equal(empty.ok, false, label);
      assert.equal(empty.status, 400, label);
      assert.equal(studioErrorSchema.parse(empty.body).error.code, "invalid_file", label);

      const tooBig = await call(oversized);
      assert.equal(tooBig.status, 413, label);
      assert.equal(studioErrorSchema.parse(tooBig.body).error.code, "file_too_large", label);

      const malformed = await call(42);
      assert.equal(malformed.status, 400, label);
      assert.equal(studioErrorSchema.parse(malformed.body).error.code, "invalid_request", label);
    }

    // None of it wrote anything: the account has exactly the page it started with.
    const db = await client();
    const { sites } = await schema();
    const { eq } = await import("drizzle-orm");
    const rows = await db.select({ id: sites.id }).from(sites).where(eq(sites.ownerId, profileId));
    assert.deepEqual(rows.map((row) => row.id), [site.id]);
  },
);

// ── Versions: replace and restore refusals (E06 task 007) ───────────────────
//
// Every refusal below is decided before a store is touched — the status gate,
// the owner scope and the version scope are all Postgres reads — so these run
// on seeded rows. The store-touching half (no-op, prune, restore) is
// `versions.test.ts`.

/** A `site_versions` row for a seeded site, optionally made current. No bytes. */
async function addVersion(siteId: string, current = false): Promise<string> {
  const db = await client();
  const { siteVersions, sites } = await schema();
  const { eq } = await import("drizzle-orm");
  const id = crypto.randomUUID();
  await db.insert(siteVersions).values({
    id,
    siteId,
    r2Key: `sites/${siteId}/${id}/index.html`,
    contentHash: `e06-007-${id}`,
    sizeBytes: 1,
  });
  if (current) await db.update(sites).set({ currentVersionId: id }).where(eq(sites.id, siteId));
  return id;
}

async function versionCount(siteId: string): Promise<number> {
  const db = await client();
  const { siteVersions } = await schema();
  const { eq, sql } = await import("drizzle-orm");
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(siteVersions)
    .where(eq(siteVersions.siteId, siteId));
  return row?.count ?? 0;
}

test(
  "replace and restore share the status gate: under_review, quarantined, expired and archived are 409 not_allowed_in_status, removed is 404, and nothing is written (AC29)",
  { skip: skipLive },
  async () => {
    const { replaceOwnedSite, restoreOwnedVersion } = await import("./owner-routes");
    const db = await client();
    const { sites } = await schema();
    const { eq } = await import("drizzle-orm");
    const profileId = await makeProfile();

    for (const [status, expected] of [
      ["under_review", 409],
      ["quarantined", 409],
      ["expired", 409],
      ["archived", 409],
      ["removed", 404],
    ] as const) {
      const site = await makeSite({ ownerId: profileId, kept: true });
      await addVersion(site.id, true);
      const older = await addVersion(site.id);
      await db.update(sites).set({ status }).where(eq(sites.id, site.id));
      const before = await readSite(site.id);

      const replaced = await replaceOwnedSite(site.id, { html: `<!doctype html><title>${status}</title>` }, profileId);
      const restored = await restoreOwnedVersion(site.id, older, profileId);

      for (const [verb, outcome] of [["replace", replaced], ["restore", restored]] as const) {
        assert.equal(outcome.ok, false, `${verb} on ${status}`);
        assert.equal(outcome.status, expected, `${verb} on ${status}`);
        const { error } = studioErrorSchema.parse(outcome.body);
        assert.equal(error.code, expected === 409 ? "not_allowed_in_status" : "not_found", `${verb} on ${status}`);
      }
      assert.deepEqual(await readSite(site.id), before, `${status}: no column moved`);
      assert.equal(await versionCount(site.id), 2, `${status}: no version written`);
    }
  },
);

test(
  "restore: another account's page is the not-found body; another page's version, an unknown one and a malformed one are version_not_found; the current version is { unchanged: true } (AC44)",
  { skip: skipLive },
  async () => {
    const { restoreOwnedVersion } = await import("./owner-routes");
    const mine = await makeProfile();
    const theirs = await makeProfile();
    const page = await makeSite({ ownerId: mine, kept: true });
    const current = await addVersion(page.id, true);
    const previous = await addVersion(page.id);
    const otherPage = await makeSite({ ownerId: mine, kept: true });
    const otherVersion = await addVersion(otherPage.id, true);
    const before = await readSite(page.id);

    // Not yours, does not exist, not a uuid: one body (D17).
    const notFound = [
      await restoreOwnedVersion(page.id, previous, theirs),
      await restoreOwnedVersion(crypto.randomUUID(), previous, mine),
      await restoreOwnedVersion("not-a-uuid", previous, mine),
    ];
    for (const outcome of notFound) assert.equal(outcome.status, 404);
    assert.equal(new Set(notFound.map((outcome) => JSON.stringify(outcome.body))).size, 1);
    assert.equal(studioErrorSchema.parse(notFound[0]!.body).error.code, "not_found");

    // A version that is not THIS page's — even the same owner's other page.
    const versionNotFound = [
      await restoreOwnedVersion(page.id, otherVersion, mine),
      await restoreOwnedVersion(page.id, crypto.randomUUID(), mine),
      await restoreOwnedVersion(page.id, "not-a-uuid", mine),
    ];
    for (const outcome of versionNotFound) {
      assert.equal(outcome.status, 404);
      assert.equal(studioErrorSchema.parse(outcome.body).error.code, "version_not_found");
    }
    assert.equal(new Set(versionNotFound.map((outcome) => JSON.stringify(outcome.body))).size, 1);

    // The version already served: a no-op success that writes nothing.
    const unchanged = await restoreOwnedVersion(page.id, current, mine);
    assert.equal(unchanged.status, 200);
    assert.deepEqual(unchanged.body, { unchanged: true });

    assert.deepEqual(await readSite(page.id), before, "none of it moved the page");
    assert.equal((await readSite(otherPage.id)).currentVersionId, otherVersion);
  },
);
