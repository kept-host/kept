/**
 * The bulk keep / delete drills — `POST /api/sites/bulk`, the drafts tab's
 * multi-select.
 *
 * NO MOCKS (project rule). Every drill runs `bulkOwnedSites` — the exact
 * function the route delegates to — against the real dev Neon branch, with
 * real rows, real transactions and real row locks. The only thing the route
 * file adds is the session lookup and the origin gate, which
 * `e2e/drafts-tab.spec.ts` covers over the wire.
 *
 * WHAT IS LOAD-BEARING:
 *
 *   1. The keep's cap is ALL OR NOTHING: past the free kept slots the whole
 *      request is `409 at_kept_limit` and not one page moves.
 *   2. Owner scoping is per page and oracle-free: another account's id, an id
 *      that never existed and one that is not a uuid each come back as that
 *      page's `not_found` — byte-identical — and the rest still happen.
 *   3. A page the single route would refuse (past grace, flagged) is refused
 *      alone, with the single route's code and sentence.
 *   4. The request is capped at `BULK_MAX_PAGES` ids.
 *
 * The delete drills also take pages off the edge (`removeManifest` → R2, KV and
 * a purge), so they additionally SKIP without the store credentials. Everything
 * SKIPS without `DATABASE_URL`, which CI's fork PRs do not have. Run locally:
 *
 *   pnpm --filter @kept/web test:unit
 *
 * Every row created here is deleted in `after`.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  BULK_MAX_PAGES,
  DRAFT_GRACE_DAYS,
  DRAFT_TTL_DAYS,
  bulkResultSchema,
  limitsFor,
  studioErrorSchema,
  type BulkItemResult,
  type SiteStatus,
} from "@kept/shared";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

/** A delete takes the page off the edge: pointer, KV and a purge. */
const STORE_VARS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_AUTO",
  "KV_NAMESPACE_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "KEPT_BASE_DOMAIN",
] as const;
const missingStores = STORE_VARS.filter((name) => !process.env[name]);
const skipStores =
  skipLive ||
  (missingStores.length > 0 ? `store credentials absent (${missingStores.join(", ")})` : false);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The cap every drill account (`free`) is held to — never a literal. */
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

async function makeProfile(): Promise<string> {
  const db = await client();
  const { profiles, user } = await schema();
  const id = crypto.randomUUID();
  const email = `bulk-${id}@kept.invalid`;
  await db.insert(user).values({ id, name: "bulk drill", email, emailVerified: true });
  await db.insert(profiles).values({ id, email, plan: "free" });
  createdProfiles.add(id);
  return id;
}

interface MakeSite {
  ownerId: string;
  /** No clock → kept; clock → owned draft. */
  kept?: boolean;
  status?: SiteStatus;
  /** Drafts only: days until `expires_at`; negative for a clock already run out. */
  expiresInDays?: number;
}

function siteRow({ ownerId, kept = false, status = "live", expiresInDays = DRAFT_TTL_DAYS }: MakeSite) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + expiresInDays * MS_PER_DAY);
  createdSites.add(id);
  return {
    id,
    slug: `bulk-${id.slice(0, 12)}`,
    status,
    region: "auto" as const,
    ownerId,
    publisherHash: "bulk-drill",
    expiresAt: kept ? null : expiresAt,
    purgeAfter: kept ? null : new Date(expiresAt.getTime() + DRAFT_GRACE_DAYS * MS_PER_DAY),
    claimedAt: new Date(),
    contentHash: "bulk-drill",
    sizeBytes: 128,
  };
}

/** Rows in ONE insert. Returns their ids in order. */
async function makeSites(...options: MakeSite[]): Promise<string[]> {
  const db = await client();
  const { sites } = await schema();
  const rows = options.map(siteRow);
  if (rows.length > 0) await db.insert(sites).values(rows);
  return rows.map((row) => row.id);
}

async function readSite(siteId: string) {
  const db = await client();
  const { sites } = await schema();
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select().from(sites).where(eq(sites.id, siteId));
  if (!row) throw new Error(`Drill row ${siteId} vanished.`);
  return row;
}

/** Kept-ness asked through the module's own predicate, never a re-spelled WHERE. */
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

/** Run the route lib and parse its 200 body as the contract the client reads. */
async function bulk(action: "keep" | "delete", ids: string[], profileId: string): Promise<BulkItemResult[]> {
  const { bulkOwnedSites } = await import("./owner-routes");
  const outcome = await bulkOwnedSites({ action, ids }, profileId);
  assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
  return bulkResultSchema.parse(outcome.body).results;
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
    await db.delete(profiles).where(inArray(profiles.id, [...createdProfiles]));
    await db.delete(user).where(inArray(user.id, [...createdProfiles]));
  }
  await db.$client.end();
});

test("the request is shaped and capped before anything is read: BULK_MAX_PAGES ids at most", async () => {
  const { bulkOwnedSites } = await import("./owner-routes");
  const profileId = crypto.randomUUID();
  const ids = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());

  for (const [raw, why] of [
    [{ action: "keep", ids: ids(BULK_MAX_PAGES + 1) }, "one id over the cap"],
    [{ action: "delete", ids: [] }, "no ids"],
    [{ action: "swap", ids: ids(1) }, "a verb there is no bulk form of"],
    [{ ids: ids(1) }, "no action"],
  ] as const) {
    const outcome = await bulkOwnedSites(raw, profileId);
    assert.equal(outcome.status, 400, why);
    assert.equal(studioErrorSchema.parse(outcome.body).error.code, "invalid_request", why);
  }
  const over = await bulkOwnedSites({ action: "delete", ids: ids(BULK_MAX_PAGES + 1) }, profileId);
  assert.equal(
    studioErrorSchema.parse(over.body).error.message,
    `Name at most ${BULK_MAX_PAGES} pages at a time.`,
  );
});

test(
  "bulk keep within the free slots keeps every draft; a foreign, unknown or malformed id is that page's not_found",
  { skip: skipLive },
  async () => {
    const owner = await makeProfile();
    const stranger = await makeProfile();
    const [a, b, c] = await makeSites({ ownerId: owner }, { ownerId: owner }, { ownerId: owner });
    const [theirs] = await makeSites({ ownerId: stranger });
    const theirsBefore = await readSite(theirs!);
    const unknown = crypto.randomUUID();

    const results = await bulk("keep", [a!, theirs!, b!, unknown, "not-a-uuid", c!, a!], owner);

    assert.deepEqual(
      results.map((item) => [item.id, item.ok]),
      [
        [a, true],
        [theirs, false],
        [b, true],
        [unknown, false],
        ["not-a-uuid", false],
        [c, true],
      ],
      "one result per DISTINCT id, in the order sent",
    );
    const refusals = results.filter((item) => !item.ok);
    for (const refusal of refusals) {
      assert.deepEqual(
        { ...refusal, id: "" },
        { ...refusals[0]!, id: "" },
        "foreign, unknown and malformed are byte-identical — no existence oracle",
      );
    }
    assert.equal(refusals[0]!.ok === false && refusals[0]!.code, "not_found");

    for (const id of [a!, b!, c!]) {
      const row = await readSite(id);
      assert.equal(row.expiresAt, null, "kept: the clock is off");
      assert.equal(row.purgeAfter, null);
    }
    assert.equal(await keptCount(owner), 3);
    assert.deepEqual(await readSite(theirs!), theirsBefore, "another account's page is untouched");
  },
);

test(
  "bulk keep past the free slots is 409 at_kept_limit, all or nothing — not one page moves",
  { skip: skipLive },
  async () => {
    const { bulkOwnedSites } = await import("./owner-routes");
    const { bulkKeepRefusal } = await import("./display");
    const profileId = await makeProfile();
    await makeSites(...Array.from({ length: FREE_LIMIT - 2 }, () => ({ ownerId: profileId, kept: true })));
    const drafts = await makeSites({ ownerId: profileId }, { ownerId: profileId }, { ownerId: profileId });
    const before = await Promise.all(drafts.map(readSite));

    const outcome = await bulkOwnedSites({ action: "keep", ids: drafts }, profileId);

    assert.equal(outcome.status, 409);
    const { error } = studioErrorSchema.parse(outcome.body);
    assert.equal(error.code, "at_kept_limit");
    assert.equal(error.message, bulkKeepRefusal(3, 2, FREE_LIMIT), "the bar's own sentence");
    assert.deepEqual(await Promise.all(drafts.map(readSite)), before, "no partial keep");
    assert.equal(await keptCount(profileId), FREE_LIMIT - 2);

    // Exactly the free slots: every one lands.
    const two = await bulk("keep", drafts.slice(0, 2), profileId);
    assert.deepEqual(two.map((item) => item.ok), [true, true]);
    assert.equal(await keptCount(profileId), FREE_LIMIT);
  },
);

test(
  "bulk keep refuses a past-grace or flagged draft alone, with the single route's code; the rest land",
  { skip: skipLive },
  async () => {
    const profileId = await makeProfile();
    const [fine, pastGrace, flagged] = await makeSites(
      { ownerId: profileId },
      { ownerId: profileId, expiresInDays: -(DRAFT_GRACE_DAYS + 10) },
      { ownerId: profileId, status: "under_review" },
    );
    const untouched = await Promise.all([pastGrace!, flagged!].map(readSite));

    const results = await bulk("keep", [fine!, pastGrace!, flagged!], profileId);

    assert.deepEqual(
      results.map((item) => (item.ok ? "ok" : item.code)),
      ["ok", "not_found", "not_allowed_in_status"],
    );
    assert.equal((await readSite(fine!)).expiresAt, null);
    assert.deepEqual(await Promise.all([pastGrace!, flagged!].map(readSite)), untouched);
  },
);

test(
  "bulk delete archives each page for its grace window; another account's id is not_found and untouched",
  { skip: skipStores },
  async () => {
    const owner = await makeProfile();
    const stranger = await makeProfile();
    const mine = await makeSites({ ownerId: owner }, { ownerId: owner }, { ownerId: owner, status: "quarantined" });
    const [theirs] = await makeSites({ ownerId: stranger });
    const theirsBefore = await readSite(theirs!);
    const started = Date.now();

    const results = await bulk("delete", [...mine, theirs!], owner);

    assert.deepEqual(
      results.map((item) => (item.ok ? "ok" : item.code)),
      ["ok", "ok", "ok", "not_found"],
      "a flagged draft is deletable on purpose — delete is one of its two affordances",
    );
    for (const id of mine) {
      const row = await readSite(id);
      assert.equal(row.status, "archived", "D14: delete archives, never destroys");
      assert.ok(row.purgeAfter, "the download window is set");
      assert.ok(
        row.purgeAfter.getTime() >= started + DRAFT_GRACE_DAYS * MS_PER_DAY - 60_000,
        "purge_after = now + DRAFT_GRACE_DAYS, from the delete",
      );
    }
    assert.deepEqual(await readSite(theirs!), theirsBefore);

    // Idempotent, like the single DELETE: deleting again is the same success.
    const again = await bulk("delete", mine, owner);
    assert.deepEqual(again.map((item) => item.ok), [true, true, true]);
  },
);
