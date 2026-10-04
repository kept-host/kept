/**
 * Delete = archive (D14) — E06 task 008, epic Verification 10 (latent bug 3)
 * and the server half of AC41.
 *
 * NO MOCKS: real dev Postgres, R2, KV and purge. Pages are published through
 * `publishOwnedPage` (what `POST /api/sites` runs), chosen names are given
 * through `renameSite` (what `PATCH /api/sites/:id/name` runs), and every
 * delete goes through `deleteOwnedSite` — the exact function `DELETE
 * /api/sites/:id` delegates to. The wire, the origin check and the edge going
 * dark are `e2e/owner-delete-api.spec.ts`.
 *
 * ⚠️ LATENT BUG 3, WRITTEN FAILING FIRST. Before task 008 a deleted kept page
 * kept `purge_after = NULL`, so E07's purge — which orders on `purge_after` —
 * would never have collected it. The first test fails on that code.
 *
 * SKIPS without dev credentials: CI runs `pnpm test` on fork PRs with no
 * secrets. Every row, object, manifest and hold created here is removed in
 * `after`.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { DRAFT_GRACE_DAYS, NAME_HOLD_DAYS, deleteResultSchema, limitsFor } from "@kept/shared";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const LIVE_VARS = [
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

const missing = LIVE_VARS.filter((name) => !process.env[name]?.trim());
const skip: string | false =
  missing.length > 0
    ? `dev credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local`
    : false;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Clock slack between this process and Postgres. */
const SLACK_MS = 5 * 60_000;

const publisher = { ip: "203.0.113.208", userAgent: "kept-e06-008-delete-drill/1.0" };
const createdSites = new Set<string>();
const createdSlugs = new Set<string>();

/** Lazy: the stores read env the moment they are used, after `config` above. */
async function deps() {
  const { NamesDrill } = await import("../testing/names-drill");
  const { pointerKey } = await import("../storage/manifest");
  const { pageObjectKey, r2Store } = await import("../storage/r2");
  return { NamesDrill, pointerKey, pageObjectKey, r2Store };
}

let drillInstance: import("../testing/names-drill").NamesDrill | null = null;
async function drill() {
  if (!drillInstance) drillInstance = new (await deps()).NamesDrill("e06-008-del");
  return drillInstance;
}

interface Published {
  siteId: string;
  slug: string;
  versionId: string;
  html: string;
}

/** A real kept page: Postgres row, R2 object, pointer, KV manifest, purge. */
async function publish(profileId: string): Promise<Published> {
  const { publishOwnedPage } = await import("./publish");
  const marker = `e06-008-${crypto.randomUUID().slice(0, 8)}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marker}</title></head><body><h1>${marker}</h1></body></html>\n`;
  const { site } = await publishOwnedPage({ profileId, html, publisher });
  createdSites.add(site.id);
  createdSlugs.add(site.slug);
  // Tracked so a hold the code under test should NOT have written is still torn down.
  (await drill()).track(site.slug);
  const row = await (await drill()).read(site.id);
  assert.ok(row.currentVersionId, "a published page has a version");
  return { siteId: site.id, slug: site.slug, versionId: row.currentVersionId, html };
}

function assertGraceFromNow(purgeAfter: Date | null, label: string) {
  assert.ok(purgeAfter, `${label}: purge_after must be set — a NULL is never collected by E07 (bug 3)`);
  const expected = Date.now() + DRAFT_GRACE_DAYS * MS_PER_DAY;
  assert.ok(
    Math.abs(purgeAfter.getTime() - expected) < SLACK_MS,
    `${label}: purge_after ${purgeAfter.toISOString()} should be ~DRAFT_GRACE_DAYS from now`,
  );
}

after(async () => {
  if (skip) return;
  const { pageObjectKey, r2Store } = await deps();
  const { removeManifest } = await import("../storage/manifest");
  const { db, closeDb } = await import("../db");
  const { siteVersions, sites } = await import("../db/schema");
  const { eq, inArray } = await import("drizzle-orm");

  for (const slug of createdSlugs) await removeManifest(slug).catch(() => undefined);
  for (const id of createdSites) {
    const versions = await db
      .select({ id: siteVersions.id })
      .from(siteVersions)
      .where(eq(siteVersions.siteId, id));
    for (const version of versions) {
      await r2Store()
        .delete(pageObjectKey(id, version.id))
        .catch(() => undefined);
    }
  }
  if (createdSites.size > 0) await db.delete(sites).where(inArray(sites.id, [...createdSites]));
  await (await drill()).cleanup();
  await closeDb();
});

test(
  "bug 3, failing first: a deleted kept page is archived with purge_after = now + DRAFT_GRACE_DAYS, its slot frees and updated_at moves",
  { skip },
  async () => {
    const { deleteOwnedSite } = await import("./owner-routes");
    const { pointerKey, pageObjectKey, r2Store } = await deps();
    const d = await drill();
    const owner = await d.profile();
    const page = await publish(owner);
    const before = await d.read(page.siteId);
    assert.equal(before.expiresAt, null, "precondition: the page is kept");
    assert.equal(before.purgeAfter, null, "precondition: a kept page has no deadline");

    const outcome = await deleteOwnedSite(page.siteId, owner);

    assert.equal(outcome.ok, true, JSON.stringify(outcome.body));
    assert.equal(outcome.status, 200);
    const body = deleteResultSchema.parse(outcome.body);
    assert.equal(body.status, "archived");
    const { keptPages } = limitsFor("free");
    assert.deepEqual(body.quota, { limit: keptPages, used: 0, remaining: keptPages }, "the slot is free");

    const row = await d.read(page.siteId);
    assert.equal(row.status, "archived");
    assertGraceFromNow(row.purgeAfter, "deleted kept page");
    assert.ok(row.updatedAt > before.updatedAt, "a delete moves updated_at");
    assert.equal(row.ownerId, owner, "the owner keeps the page to download until purge_after");
    assert.equal(await d.holdOf(page.slug), null, "a generated name is never held");

    // The edge is off; the bytes stay for the owner's download window and E07.
    assert.equal(await r2Store().get(pointerKey(page.slug)), null);
    assert.equal(await r2Store().get(pageObjectKey(page.siteId, page.versionId)), page.html);
  },
);

test(
  "a chosen name is held for its owner, and a second DELETE is 200 with no second hold and no purge_after bump",
  { skip },
  async () => {
    const { deleteOwnedSite } = await import("./owner-routes");
    const { renameSite } = await import("../names/rename");
    const { isNameAvailable } = await import("../names/availability");
    const d = await drill();
    const owner = await d.profile();
    const stranger = await d.profile();
    const page = await publish(owner);
    const chosen = d.name();
    await renameSite(page.siteId, owner, chosen);
    createdSlugs.add(chosen);

    const first = await deleteOwnedSite(page.siteId, owner);
    assert.equal(first.ok, true, JSON.stringify(first.body));

    const hold = await d.holdOf(chosen);
    assert.ok(hold, "deleting a page with a chosen name holds the name");
    assert.equal(hold.userId, owner);
    assert.equal(hold.siteId, page.siteId);
    assert.equal(hold.reason, "deleted");
    assert.ok(
      Math.abs(hold.heldUntil.getTime() - (Date.now() + NAME_HOLD_DAYS * MS_PER_DAY)) < SLACK_MS,
      "held for NAME_HOLD_DAYS",
    );
    assert.equal(await isNameAvailable(chosen, owner), "held_for_you");
    assert.equal(await isNameAvailable(chosen, stranger), "taken");

    const archived = await d.read(page.siteId);
    assertGraceFromNow(archived.purgeAfter, "deleted chosen-name page");

    const second = await deleteOwnedSite(page.siteId, owner);
    assert.equal(second.ok, true, "deleting twice reaches the state asked for — a success");
    assert.equal(second.status, 200);
    assert.equal(deleteResultSchema.parse(second.body).status, "archived");
    assert.deepEqual(await d.read(page.siteId), archived, "no second purge_after bump, no row write");
    assert.deepEqual(await d.holdOf(chosen), hold, "no second hold");
  },
);

test(
  "another account's page, a removed page, an unknown id and a malformed one are the same 404, and nothing moves",
  { skip },
  async () => {
    const { deleteOwnedSite } = await import("./owner-routes");
    const d = await drill();
    const owner = await d.profile();
    const other = await d.profile();
    const theirs = await d.site({ ownerId: other });
    // `removed` is E07's takedown: to its owner it is not found, and an owner
    // delete must never turn it back into `archived`.
    const removed = await d.site({ ownerId: owner, status: "removed" });
    const beforeTheirs = await d.read(theirs.id);
    const beforeRemoved = await d.read(removed.id);

    const bodies: string[] = [];
    for (const id of [theirs.id, removed.id, crypto.randomUUID(), "not-a-uuid"]) {
      const outcome = await deleteOwnedSite(id, owner);
      assert.equal(outcome.ok, false, id);
      assert.equal(outcome.status, 404, id);
      bodies.push(JSON.stringify(outcome.body));
    }
    assert.equal(new Set(bodies).size, 1, "one body for every not-found — never an existence oracle");
    assert.deepEqual(await d.read(theirs.id), beforeTheirs);
    assert.deepEqual(await d.read(removed.id), beforeRemoved);
  },
);
