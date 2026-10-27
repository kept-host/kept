/**
 * The keyed page service (`./pages.ts`) against the REAL dev stack — E09 task
 * 008, D8.
 *
 * NO MOCKS. Two publishes go through the studio's own pipeline — Postgres, R2,
 * KV and the purge all run:
 *
 *   1. ONE page on an empty free account, kept, then reused for get → list
 *      (with seeded rows past one list page, so the cursor is walked) →
 *      replace → another account's view → delete.
 *   2. ONE page on a free account whose kept slots are filled by seeded rows
 *      (no bytes behind them): it lands a draft with `expires_at`, not a 4xx.
 *
 * ≈ 4 KV writes (two publishes, a replace, a delete) plus the teardown's.
 * SKIPS without dev credentials. Every row, object, KV key and rate bucket is
 * removed in `after`. Run with
 *
 *   pnpm --filter @kept/web exec tsx --test lib/agents/pages.test.ts
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { KEYED_LIST_PAGE_SIZE, limitsFor, type Plan } from "@kept/shared";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";

import { closeDb, db } from "../db";
import { siteObjectKeys } from "../db/queries/version-files";
import { profiles, rateLimits, siteVersions, sites, user } from "../db/schema";
import { readJsonSet } from "../testing/file-sets";
import { pageObjectKey, r2Store } from "../storage/r2";

import type { KeyCaller } from "./keys";
import { keyedDelete, keyedGet, keyedList, keyedPublish, keyedReplace } from "./pages";

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
  "NEXT_PUBLIC_APP_URL",
] as const;

const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
const skip: string | false =
  missing.length > 0 ? `dev credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local` : false;

const createdUsers = new Set<string>();
const createdSites = new Set<string>();
const publishedSlugs = new Set<string>();
const keyIds = new Set<string>();

const publisher = { ip: "127.0.0.1", userAgent: "kept-e09-008-drill/1.0" };
const source = { client: "e09/test", publishedVia: "api" as const };

const pageHtml = (marker: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marker}</title></head><body><h1>${marker}</h1></body></html>\n`;

/** An account and a caller for it. The key row itself is not needed: the service takes a resolved caller. */
async function makeCaller(plan: Plan): Promise<KeyCaller> {
  const id = crypto.randomUUID();
  await db.insert(user).values({ id, name: "E09-008 drill", email: `e09-008-${id}@kept.invalid`, emailVerified: true });
  await db.insert(profiles).values({ id, email: `e09-008-${id}@kept.invalid`, plan });
  createdUsers.add(id);
  const keyId = crypto.randomUUID();
  keyIds.add(keyId);
  return { keyId, profileId: id, plan };
}

/** `n` rows in one insert; `withVersions` gives each a current version so the keyed reads see them. */
async function seed(profileId: string, n: number, withVersions: boolean): Promise<void> {
  const rows = Array.from({ length: n }, () => {
    const id = crypto.randomUUID();
    createdSites.add(id);
    return {
      id,
      slug: `e09-008-${id.slice(0, 12)}`,
      ownerId: profileId,
      publisherHash: "e09-008-drill",
      claimedAt: new Date(),
      contentHash: "e09-008",
      sizeBytes: 128,
    };
  });
  await db.insert(sites).values(rows);
  if (!withVersions) return;
  const versions = rows.map((row) => ({
    id: crypto.randomUUID(),
    siteId: row.id,
    region: "auto" as const,
    r2Key: `sites/${row.id}/seed/index.html`,
    contentHash: "e09-008",
    sizeBytes: 128,
  }));
  await db.insert(siteVersions).values(versions);
  for (const version of versions) {
    await db.update(sites).set({ currentVersionId: version.id }).where(eq(sites.id, version.siteId));
  }
}

after(async () => {
  if (skip) return;
  await (await import("../testing/served-manifests")).removeServedManifests(publishedSlugs);
  await (await import("../testing/pending-purges")).clearPendingPurges(publishedSlugs, createdSites);
  for (const siteId of createdSites) {
    const versions = await db.select({ id: siteVersions.id }).from(siteVersions).where(eq(siteVersions.siteId, siteId));
    const keys = [...versions.map((v) => pageObjectKey(siteId, v.id)), ...(await siteObjectKeys(db, siteId))];
    if (keys.length > 0) await r2Store().deleteMany(keys).catch(() => undefined);
  }
  if (createdSites.size > 0) await db.delete(sites).where(inArray(sites.id, [...createdSites]));
  if (createdUsers.size > 0) await db.delete(user).where(inArray(user.id, [...createdUsers]));
  if (keyIds.size > 0) {
    await db.delete(rateLimits).where(inArray(rateLimits.bucket, [...keyIds].map((id) => `key:${id}`)));
  }
  await closeDb();
});

test("one keyed page: publish kept → get → list with a cursor → replace → not another key's → delete", { skip }, async () => {
  const caller = await makeCaller("free");
  const stranger = await makeCaller("free");

  // A refused set passes through flat, with its own code, and costs no key-bucket hit.
  const refused = await keyedPublish(caller, await readJsonSet({ html: "" }), publisher, source);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.status, 400);
    assert.ok(["empty_page", "invalid_request"].includes(refused.body.error), refused.body.error);
  }

  const published = await keyedPublish(caller, await readJsonSet({ html: pageHtml("e09-008 keyed"), model: "drill-model" }), publisher, source);
  assert.ok(published.ok, JSON.stringify(published));
  assert.equal(published.status, 201);
  const { slug } = published.body;
  const [row] = await db.select().from(sites).where(eq(sites.slug, slug));
  assert.ok(row);
  createdSites.add(row.id);
  publishedSlugs.add(slug);
  assert.equal(published.body.kept, true, "a free slot → kept");
  assert.equal(published.body.expires_at, null);
  assert.equal(row.ownerId, caller.profileId, "the key's owner has it");
  assert.equal(row.anonTokenHash, null, "no claim token");
  assert.equal(published.body.studio_url, `${process.env.NEXT_PUBLIC_APP_URL!.replace(/\/+$/, "")}/site/${row.id}`);
  assert.equal(published.body.live_url, `https://${slug}.${process.env.KEPT_BASE_DOMAIN}`);
  const [version] = await db
    .select({ client: siteVersions.client, publishedVia: siteVersions.publishedVia })
    .from(siteVersions)
    .where(eq(siteVersions.siteId, row.id));
  assert.deepEqual(version, { client: "e09/test", publishedVia: "api" });

  const got = await keyedGet(caller, slug);
  assert.ok(got.ok);
  assert.equal(got.body.title, "e09-008 keyed");
  assert.equal(got.body.model, "drill-model");
  assert.equal(got.body.file_count, 1);
  assert.equal(got.body.kept, true);

  // One list page past the size: the cursor walks every row exactly once.
  await seed(caller.profileId, KEYED_LIST_PAGE_SIZE, true);
  const first = await keyedList(caller);
  assert.ok(first.ok);
  assert.equal(first.body.pages.length, KEYED_LIST_PAGE_SIZE);
  assert.ok(first.body.next_cursor, "a second page follows");
  const second = await keyedList(caller, first.body.next_cursor);
  assert.ok(second.ok);
  assert.equal(second.body.pages.length, 1);
  assert.equal(second.body.next_cursor, null);
  const listed = [...first.body.pages, ...second.body.pages].map((page) => page.slug);
  assert.equal(new Set(listed).size, KEYED_LIST_PAGE_SIZE + 1, "no row twice");
  assert.ok(listed.includes(slug));
  const badCursor = await keyedList(caller, "not-a-cursor");
  assert.equal(badCursor.ok ? 200 : badCursor.status, 400);

  // Another account's key: the same 404 as a slug that names nothing.
  for (const outcome of [
    await keyedGet(stranger, slug),
    await keyedReplace(stranger, slug, await readJsonSet({ html: pageHtml("hijack") }), source),
    await keyedDelete(stranger, slug),
    await keyedGet(caller, "no-such-page-e09-008"),
    await keyedGet(caller, "NOT A SLUG"),
  ]) {
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.deepEqual([outcome.status, outcome.body.error], [404, "not_found"]);
  }

  const replaced = await keyedReplace(caller, slug, await readJsonSet({ html: pageHtml("e09-008 replaced") }), source);
  assert.ok(replaced.ok, JSON.stringify(replaced));
  assert.equal(replaced.body.slug, slug, "same URL");
  assert.equal(replaced.body.kept, true, "kept-ness untouched");
  const [current] = await db.select().from(sites).where(eq(sites.id, row.id));
  assert.notEqual(current?.currentVersionId, row.currentVersionId, "a new version serves");
  assert.equal(current?.title, "e09-008 replaced");

  const deleted = await keyedDelete(caller, slug);
  assert.ok(deleted.ok, JSON.stringify(deleted));
  assert.deepEqual(deleted.body, { slug, deleted: true });
  const [archived] = await db.select({ status: sites.status }).from(sites).where(eq(sites.id, row.id));
  assert.equal(archived?.status, "archived", "archived, not destroyed");
  const gone = await keyedGet(caller, slug);
  assert.equal(gone.ok ? 200 : gone.status, 404);
});

test("at the kept cap a keyed publish lands a draft with expires_at — never a 4xx", { skip }, async () => {
  const caller = await makeCaller("free");
  await seed(caller.profileId, limitsFor("free").keptPages, false);

  const published = await keyedPublish(caller, await readJsonSet({ html: pageHtml("e09-008 at the cap") }), publisher, source);
  assert.ok(published.ok, JSON.stringify(published));
  assert.equal(published.status, 201);
  publishedSlugs.add(published.body.slug);
  const [row] = await db.select().from(sites).where(eq(sites.slug, published.body.slug));
  assert.ok(row);
  createdSites.add(row.id);
  assert.equal(published.body.kept, false);
  assert.equal(published.body.expires_at, row.expiresAt?.toISOString());
  assert.ok(row.expiresAt instanceof Date, "the draft clock is set");
});
