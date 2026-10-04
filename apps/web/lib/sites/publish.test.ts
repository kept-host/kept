/**
 * The owned publish at the kept limit, against the REAL dev stack — E06 task
 * 003, PRD acceptance criterion **2** (the library half; task 005 asserts the
 * route's status codes and task 011 the toast).
 *
 * NO MOCKS. Both publishes per drill go through `publishOwnedPage` — the same
 * function `POST /api/sites` calls — so Postgres, R2, KV and the edge purge all
 * genuinely run. Only the slots BEFORE them are seeded, by direct insert: real
 * `sites` rows that the cap's count genuinely sees, because publishing dozens of
 * pages to reach the limit would be minutes of R2/KV traffic proving nothing the
 * last two publishes do not.
 *
 * ── THE TWO CLAIMS ───────────────────────────────────────────────────────────
 *
 *  1. **The limit degrades, it never errors.** A free account one slot short
 *     publishes → `kept`; publishes again → an OWNED DRAFT with both clocks set.
 *     Neither throws.
 *  2. **The limit is the account's plan's, not the free alias.** A premium
 *     account already holding the free limit publishes → still `kept`, and the
 *     quota it reports carries the premium number. A cap read from
 *     `KEPT_PAGE_LIMIT` passes claim 1 and fails this one.
 *
 * SKIPS without dev credentials: CI runs `pnpm test` on fork PRs with no cloud
 * secrets. Run locally with `pnpm --filter @kept/web test:unit`.
 *
 * Every row, object and KV key created here is removed in `after`.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { limitsFor, type Plan } from "@kept/shared";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";

import { closeDb, db } from "../db";
import { profiles, siteVersions, sites, user } from "../db/schema";
import { pageObjectKey, r2Store } from "../storage/r2";

import { publishOwnedPage } from "./publish";

config({ path: ".env.local", quiet: true });

const REQUIRED = [
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_AUTO",
  "KV_NAMESPACE_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "KEPT_BASE_DOMAIN",
  "PUBLISHER_HASH_SALT",
] as const;

const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
const skip: string | false =
  missing.length > 0
    ? `dev credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local`
    : false;

const FREE_LIMIT = limitsFor("free").keptPages;

const createdUsers = new Set<string>();
const createdSites = new Set<string>();
/** Slugs `publishOwnedPage` wrote a manifest for, and `after` must remove. */
const publishedSlugs = new Set<string>();

const publisher = { ip: "127.0.0.1", userAgent: "kept-e06-003-drill/1.0" };

async function makeAccount(plan: Plan): Promise<string> {
  const id = crypto.randomUUID();
  const email = `e06-003-${id.slice(0, 12)}@kept-e06-003.invalid`;
  await db.insert(user).values({ id, name: "E06-003 cap drill", email, emailVerified: true });
  await db.insert(profiles).values({ id, email, plan });
  createdUsers.add(id);
  return id;
}

/** `n` kept rows in ONE insert — real rows the cap counts, with no bytes behind them. */
async function seedKept(profileId: string, n: number): Promise<void> {
  const rows = Array.from({ length: n }, () => {
    const id = crypto.randomUUID();
    createdSites.add(id);
    return {
      id,
      slug: `e06-003-${id.slice(0, 12)}`,
      ownerId: profileId,
      publisherHash: "e06-003-drill",
      claimedAt: new Date(),
      contentHash: "e06-003",
      sizeBytes: 128,
    };
  });
  await db.insert(sites).values(rows);
}

async function publish(profileId: string, marker: string) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marker}</title></head><body><h1>${marker}</h1></body></html>\n`;
  const result = await publishOwnedPage({ profileId, html, publisher });
  createdSites.add(result.siteId);
  publishedSlugs.add(result.slug);
  return result;
}

async function readSite(siteId: string) {
  const [row] = await db.select().from(sites).where(eq(sites.id, siteId));
  assert.ok(row, `site ${siteId} vanished`);
  return row;
}

after(async () => {
  if (skip) return;
  const { removeManifest } = await import("../storage/manifest");
  for (const slug of publishedSlugs) {
    await removeManifest(slug).catch(() => undefined);
  }
  if (createdSites.size > 0) {
    const versions = await db
      .select({ id: siteVersions.id, siteId: siteVersions.siteId })
      .from(siteVersions)
      .where(inArray(siteVersions.siteId, [...createdSites]));
    for (const version of versions) {
      await r2Store()
        .delete(pageObjectKey(version.siteId, version.id))
        .catch(() => undefined);
    }
    await db.delete(sites).where(inArray(sites.id, [...createdSites]));
  }
  if (createdUsers.size > 0) {
    // `profiles` cascades off `user.id`.
    await db.delete(user).where(inArray(user.id, [...createdUsers]));
  }
  // No resource leak: `postgres-js` holds the pool open and the process would
  // otherwise never exit.
  await closeDb();
});

test(
  "AC2: a free account one short of its limit publishes kept, then an owned draft — never an error",
  { skip },
  async () => {
    const owner = await makeAccount("free");
    await seedKept(owner, FREE_LIMIT - 1);

    const last = await publish(owner, "e06-003-last-slot");
    assert.equal(last.outcome, "kept", "the last free slot is a kept page");
    assert.deepEqual(last.quota, { limit: FREE_LIMIT, used: FREE_LIMIT, remaining: 0 });
    const lastRow = await readSite(last.siteId);
    assert.equal(lastRow.expiresAt, null);
    assert.equal(lastRow.purgeAfter, null);

    const past = await publish(owner, "e06-003-past-the-limit");
    assert.equal(past.outcome, "owned_draft", "past the limit the page degrades to a draft");
    assert.deepEqual(past.quota, { limit: FREE_LIMIT, used: FREE_LIMIT, remaining: 0 });
    const pastRow = await readSite(past.siteId);
    assert.equal(pastRow.ownerId, owner, "the draft is OWNED — the account has it");
    assert.equal(pastRow.anonTokenHash, null, "and no bearer token was minted for it");
    assert.equal(pastRow.status, "live", "it is serving right now");
    assert.ok(pastRow.expiresAt instanceof Date, "the draft clock is set");
    assert.ok(pastRow.purgeAfter instanceof Date, "and so is the grace window");
    assert.equal(
      past.outcome === "owned_draft" && past.expiresAt,
      pastRow.expiresAt.toISOString(),
      "the result reports the clock the row holds",
    );
  },
);

test(
  "the limit is the PLAN's: a premium account already holding the free limit still publishes kept",
  { skip },
  async () => {
    const premium = limitsFor("premium").keptPages;
    assert.ok(premium > FREE_LIMIT, "precondition: the premium limit is the larger one");

    const owner = await makeAccount("premium");
    await seedKept(owner, FREE_LIMIT);

    const result = await publish(owner, "e06-003-premium");
    assert.equal(result.outcome, "kept", "the plan is read, not the free alias");
    assert.deepEqual(result.quota, {
      limit: premium,
      used: FREE_LIMIT + 1,
      remaining: premium - FREE_LIMIT - 1,
    });
    assert.equal((await readSite(result.siteId)).expiresAt, null);
  },
);
