/**
 * The owned publish against the REAL dev stack — PRD acceptance criteria **2**
 * (the library half; `e2e/owner-publish-api.spec.ts` asserts the route's status
 * codes and task 011 the toast) and **8** (owner dedup).
 *
 * NO MOCKS. Every publish goes through `publishOwnedPage` — the same function
 * `POST /api/sites` calls — so Postgres, R2, KV and the edge purge all
 * genuinely run. Only the slots BEFORE them are seeded, by direct insert: real
 * `sites` rows that the cap's count genuinely sees, because publishing dozens of
 * pages to reach the limit would be minutes of R2/KV traffic proving nothing the
 * last two publishes do not.
 *
 * ── THE CLAIMS ───────────────────────────────────────────────────────────────
 *
 *  1. **The limit degrades, it never errors.** A free account one slot short
 *     publishes → kept; publishes again → an OWNED DRAFT with both clocks set.
 *     Neither throws.
 *  2. **The limit is the account's plan's, not the free alias.** A premium
 *     account already holding the free limit publishes → still kept. A cap read
 *     from `KEPT_PAGE_LIMIT` passes claim 1 and fails this one.
 *  3. **The same bytes are one page per owner (AC8)** — sequentially, and when
 *     two identical publishes race (`Promise.all`): the probe runs inside the
 *     `lockOwner` transaction, so the second finds the first.
 *  4. **An offline page is not a duplicate.** The same bytes as an archived or
 *     an expired page mint a fresh page.
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
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

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

const pageHtml = (marker: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marker}</title></head><body><h1>${marker}</h1></body></html>\n`;

/** Publish exact bytes, recording whatever page came back for teardown. */
async function publishHtml(profileId: string, html: string) {
  const result = await publishOwnedPage({ profileId, html, publisher });
  createdSites.add(result.site.id);
  publishedSlugs.add(result.site.slug);
  return result;
}

const publish = (profileId: string, marker: string) => publishHtml(profileId, pageHtml(marker));

/** Every row this owner has, whatever its state — the count dedup must hold flat. */
async function ownedCount(profileId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sites)
    .where(eq(sites.ownerId, profileId));
  return row?.count ?? 0;
}

/** The kept-ness predicate, asked of the database rather than of a response. */
async function keptCount(profileId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sites)
    .where(and(eq(sites.ownerId, profileId), isNull(sites.expiresAt), eq(sites.status, "live")));
  return row?.count ?? 0;
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

    const last = await publish(owner, "e06-005-last-slot");
    assert.equal(last.duplicate, undefined, "a new page is not a duplicate");
    assert.equal(last.site.expiresAt, null, "the last free slot is a kept page");
    assert.equal(await keptCount(owner), FREE_LIMIT);
    const lastRow = await readSite(last.site.id);
    assert.equal(lastRow.expiresAt, null);
    assert.equal(lastRow.purgeAfter, null);

    const past = await publish(owner, "e06-005-past-the-limit");
    assert.notEqual(past.site.expiresAt, null, "past the limit the page degrades to a draft");
    assert.equal(await keptCount(owner), FREE_LIMIT, "the cap did not move");
    const pastRow = await readSite(past.site.id);
    assert.equal(pastRow.ownerId, owner, "the draft is OWNED — the account has it");
    assert.equal(pastRow.anonTokenHash, null, "and no bearer token was minted for it");
    assert.equal(pastRow.status, "live", "it is serving right now");
    assert.ok(pastRow.expiresAt instanceof Date, "the draft clock is set");
    assert.ok(pastRow.purgeAfter instanceof Date, "and so is the grace window");
    assert.equal(
      past.site.expiresAt,
      pastRow.expiresAt.toISOString(),
      "the result reports the clock the row holds",
    );
    assert.equal(past.site.purgeAfter, pastRow.purgeAfter.toISOString());
    assert.equal(past.site.updatedAt, pastRow.updatedAt.toISOString());
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

    const result = await publish(owner, "e06-005-premium");
    assert.equal(result.site.expiresAt, null, "the plan is read, not the free alias");
    assert.equal(await keptCount(owner), FREE_LIMIT + 1);
    assert.equal((await readSite(result.site.id)).expiresAt, null);
  },
);

test(
  "the site answer is the row: id, slug, live URL, title, status — and the version says studio",
  { skip },
  async () => {
    const owner = await makeAccount("free");
    const marker = `e06-005-shape-${crypto.randomUUID().slice(0, 8)}`;
    const { site } = await publish(owner, marker);

    const row = await readSite(site.id);
    assert.equal(site.slug, row.slug);
    assert.equal(site.liveUrl, `https://${row.slug}.${process.env.KEPT_BASE_DOMAIN}`);
    assert.equal(site.title, marker);
    assert.equal(row.title, marker);
    assert.equal(row.titleSource, "html");
    assert.equal(site.status, "live");

    const [version] = await db
      .select({ publishedVia: siteVersions.publishedVia })
      .from(siteVersions)
      .where(eq(siteVersions.siteId, site.id));
    assert.equal(version?.publishedVia, "studio", "§5.9: a studio publish records its door");
  },
);

test(
  "AC8: the same bytes published twice by one owner are one page; the second answer points at it",
  { skip },
  async () => {
    const owner = await makeAccount("free");
    const html = pageHtml(`e06-005-dedup-${crypto.randomUUID().slice(0, 8)}`);

    const first = await publishHtml(owner, html);
    assert.equal(first.duplicate, undefined);

    const second = await publishHtml(owner, html);
    assert.equal(second.duplicate, true);
    assert.deepEqual(second.site, first.site, "the duplicate IS the first page, as it stands");
    assert.equal(await ownedCount(owner), 1, "no second row was written");

    const versions = await db
      .select({ id: siteVersions.id })
      .from(siteVersions)
      .where(eq(siteVersions.siteId, first.site.id));
    assert.equal(versions.length, 1, "and no second version");

    // Scoped to the OWNER: another account publishing the same bytes gets its own page.
    const other = await makeAccount("free");
    const theirs = await publishHtml(other, html);
    assert.equal(theirs.duplicate, undefined);
    assert.notEqual(theirs.site.id, first.site.id);
  },
);

test(
  "AC8: two identical publishes racing from two tabs converge on ONE page",
  { skip },
  async () => {
    const owner = await makeAccount("free");
    const html = pageHtml(`e06-005-race-${crypto.randomUUID().slice(0, 8)}`);

    // FIRED CONCURRENTLY. A probe outside the owner lock lets both see "none"
    // and both insert; inside it, the second waits and then finds the first.
    const results = await Promise.all([publishHtml(owner, html), publishHtml(owner, html)]);

    assert.equal(results[0].site.id, results[1].site.id, "both answers name the same page");
    assert.deepEqual(
      results.map((result) => result.duplicate === true).sort(),
      [false, true],
      "exactly one of the two made the page",
    );
    assert.equal(await ownedCount(owner), 1);
  },
);

test(
  "an offline page is not a duplicate: the same bytes as an archived or expired page mint a fresh one",
  { skip },
  async () => {
    const owner = await makeAccount("free");
    const html = pageHtml(`e06-005-offline-${crypto.randomUUID().slice(0, 8)}`);

    const archived = await publishHtml(owner, html);
    await db.update(sites).set({ status: "archived" }).where(eq(sites.id, archived.site.id));
    const afterArchive = await publishHtml(owner, html);
    assert.equal(afterArchive.duplicate, undefined, "an archived page is gone");
    assert.notEqual(afterArchive.site.id, archived.site.id);

    // A draft whose clock ran out but which the expiry sweep has not reached.
    const past = new Date(Date.now() - 60_000);
    await db
      .update(sites)
      .set({ expiresAt: past, purgeAfter: new Date(Date.now() + 60_000) })
      .where(eq(sites.id, afterArchive.site.id));
    const afterExpiry = await publishHtml(owner, html);
    assert.equal(afterExpiry.duplicate, undefined, "an expired draft is offline");
    assert.notEqual(afterExpiry.site.id, afterArchive.site.id);

    // …and the page that IS active now is what the next identical publish finds.
    const again = await publishHtml(owner, html);
    assert.equal(again.duplicate, true);
    assert.equal(again.site.id, afterExpiry.site.id);
  },
);
