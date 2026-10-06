/**
 * `PATCH /api/sites/:id` — a page's Details: its title and its Explore flag
 * (PRD §5.2, D11, D12). E06 task 012.
 *
 * NO MOCKS (project rule). Every case runs `updateOwnedSite` — the exact
 * function the route delegates to — against the real dev Neon branch, and the
 * title revert reads a real object from real R2. The route file adds only the
 * origin gate and the session lookup, which `e2e/owner-details-api.spec.ts`
 * covers over the wire (AC44).
 *
 * The load-bearing cases:
 *
 *   · **Bug 4 (title half, failing-first):** a title edit moves
 *     `sites.updated_at`, so the OG card's `?v=` URL changes and a year-long
 *     `immutable` cache cannot keep showing the old title.
 *   · **AC36:** the edit persists with `title_source = 'owner'`; clearing it
 *     re-derives the page's own `<title>` from the CURRENT version's bytes and
 *     hands the title back to `html`; a replace never overwrites an owner title.
 *   · **D12:** `listedPublic` is a kept `live` page's choice only.
 *   · **D17:** another account's page, a malformed id and a `removed` page are
 *     the one not-found body.
 *
 * SKIPS without dev credentials; every row and object is deleted in `after`.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  DRAFT_GRACE_DAYS,
  DRAFT_TTL_DAYS,
  PAGE_TITLE_MAX_LENGTH,
  type SiteStatus,
  siteUpdateResultSchema,
  studioErrorSchema,
} from "@kept/shared";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const LIVE_VARS = [
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_AUTO",
  "KEPT_BASE_DOMAIN",
] as const;

const missing = LIVE_VARS.filter((name) => !process.env[name]?.trim());
const skip: string | false =
  missing.length > 0
    ? `dev credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local`
    : false;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const createdSites = new Set<string>();
const createdUsers = new Set<string>();
const createdObjects = new Set<string>();

async function deps() {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../db/index");
  const { profiles, siteVersions, sites, user } = await import("../db/schema");
  const { PAGE_CONTENT_TYPE, pageObjectKey, r2Store } = await import("../storage/r2");
  const { updateOwnedSite } = await import("./owner-routes");
  return {
    eq,
    db,
    profiles,
    siteVersions,
    sites,
    user,
    PAGE_CONTENT_TYPE,
    pageObjectKey,
    r2Store,
    updateOwnedSite,
  };
}

async function makeOwner(): Promise<string> {
  const { db, profiles, user } = await deps();
  const id = crypto.randomUUID();
  const email = `e06-012-${id.slice(0, 8)}@kept-e06-012.invalid`;
  await db.insert(user).values({ id, name: "E06-012 drill", email, emailVerified: true });
  await db.insert(profiles).values({ id, email, plan: "free" });
  createdUsers.add(id);
  return id;
}

interface Seed {
  status?: SiteStatus;
  /** No clock → kept; a clock → owned draft. */
  kept?: boolean;
  /** The current version's bytes, written to real R2. Omitted → no version. */
  html?: string;
}

/**
 * One owned row, `updated_at` pinned an hour back so a write that moves it is
 * unmistakable. With `html`, a real R2 object and a `site_versions` row the
 * site points at — the bytes a title revert must read.
 */
async function seedSite(ownerId: string, seed: Seed = {}): Promise<string> {
  const { db, eq, PAGE_CONTENT_TYPE, pageObjectKey, r2Store, sites, siteVersions } = await deps();
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = seed.kept === false ? new Date(now + DRAFT_TTL_DAYS * MS_PER_DAY) : null;
  await db.insert(sites).values({
    id,
    slug: `e06-012-${id.slice(0, 12)}`,
    status: seed.status ?? "live",
    ownerId,
    publisherHash: "e06-012-drill",
    claimedAt: new Date(now),
    expiresAt,
    purgeAfter: expiresAt ? new Date(expiresAt.getTime() + DRAFT_GRACE_DAYS * MS_PER_DAY) : null,
    contentHash: "e06-012",
    sizeBytes: 128,
    title: "Extracted at publish",
    updatedAt: new Date(now - 60 * 60 * 1000),
  });
  createdSites.add(id);

  if (seed.html !== undefined) {
    const versionId = crypto.randomUUID();
    const r2Key = pageObjectKey(id, versionId);
    await r2Store().put(r2Key, seed.html, PAGE_CONTENT_TYPE);
    createdObjects.add(r2Key);
    await db.insert(siteVersions).values({
      id: versionId,
      siteId: id,
      r2Key,
      contentHash: "e06-012",
      sizeBytes: seed.html.length,
      publishedVia: "studio",
    });
    await db
      .update(sites)
      .set({ currentVersionId: versionId, updatedAt: new Date(now - 60 * 60 * 1000) })
      .where(eq(sites.id, id));
  }
  return id;
}

async function row(siteId: string) {
  const { db, eq, sites } = await deps();
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId));
  assert.ok(site, `site ${siteId} vanished`);
  return site;
}

after(async () => {
  if (skip) return;
  const { db, profiles, r2Store, sites, user } = await deps();
  const { inArray } = await import("drizzle-orm");
  for (const key of createdObjects) await r2Store().delete(key).catch(() => undefined);
  if (createdSites.size) await db.delete(sites).where(inArray(sites.id, [...createdSites]));
  if (createdUsers.size) {
    await db.delete(profiles).where(inArray(profiles.id, [...createdUsers]));
    await db.delete(user).where(inArray(user.id, [...createdUsers]));
  }
  await db.$client.end();
});

test("Bug 4 (failing-first): a title edit moves updated_at, so the OG card URL changes", { skip }, async () => {
  const { updateOwnedSite } = await deps();
  const { ogCardPath } = await import("../og/card-url");
  const owner = await makeOwner();
  const siteId = await seedSite(owner);
  const before = await row(siteId);

  const outcome = await updateOwnedSite(siteId, { title: "Owner's own title" }, owner);
  assert.equal(outcome.status, 200, JSON.stringify(outcome.body));

  const after = await row(siteId);
  assert.ok(
    after.updatedAt.getTime() > before.updatedAt.getTime(),
    "updated_at must move — it is the OG card's cache key",
  );
  assert.notEqual(
    ogCardPath(after),
    ogCardPath(before),
    "a cached card under the old URL would show the old title for a year",
  );
});

test("AC36: a title edit persists as the owner's; clearing it re-derives the page's own <title>", { skip }, async () => {
  const { updateOwnedSite } = await deps();
  const owner = await makeOwner();
  const siteId = await seedSite(owner, {
    html: "<!doctype html><html><head><title>  The page &amp; its   title </title></head><body>x</body></html>",
  });

  const set = await updateOwnedSite(siteId, { title: "  Recipe   notes " }, owner);
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const saved = siteUpdateResultSchema.parse(set.body).site;
  assert.equal(saved.title, "Recipe notes", "whitespace collapsed and trimmed");
  assert.equal(saved.titleSource, "owner");
  assert.equal((await row(siteId)).titleSource, "owner");

  const cleared = await updateOwnedSite(siteId, { title: "   " }, owner);
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const reverted = siteUpdateResultSchema.parse(cleared.body).site;
  assert.equal(reverted.title, "The page & its title", "read back from the current version's bytes in R2");
  assert.equal(reverted.titleSource, "html");
  const stored = await row(siteId);
  assert.equal(stored.title, "The page & its title");
  assert.equal(stored.titleSource, "html");
});

test("AC36: a replace never overwrites an owner title", { skip }, async () => {
  const { updateOwnedSite } = await deps();
  const { insertReplacementVersion } = await import("../db/queries/publish");
  const { pageObjectKey } = await deps();
  const owner = await makeOwner();
  const siteId = await seedSite(owner);

  await updateOwnedSite(siteId, { title: "Mine" }, owner);
  const versionId = crypto.randomUUID();
  const kept = await insertReplacementVersion({
    siteId,
    versionId,
    r2Key: pageObjectKey(siteId, versionId),
    title: "From the new bytes",
    contentHash: "e06-012-replaced",
    sizeBytes: 64,
    publishedVia: "studio",
  });
  assert.equal(kept.title, "Mine", "the replace keeps the owner's title");
  assert.equal((await row(siteId)).title, "Mine");
});

test("D12: listedPublic is a kept live page's choice — refused on a draft and on a flagged page", { skip }, async () => {
  const { updateOwnedSite } = await deps();
  const owner = await makeOwner();

  const kept = await seedSite(owner);
  const on = await updateOwnedSite(kept, { listedPublic: true }, owner);
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(siteUpdateResultSchema.parse(on.body).site.listedPublic, true);
  assert.equal((await row(kept)).listedPublic, true);

  for (const [label, seed] of [
    ["a draft", { kept: false }],
    ["a kept page under review", { status: "under_review" as const }],
    ["a quarantined kept page", { status: "quarantined" as const }],
  ] as const) {
    const siteId = await seedSite(owner, seed);
    const refused = await updateOwnedSite(siteId, { listedPublic: true }, owner);
    assert.equal(refused.status, 409, `${label}: ${JSON.stringify(refused.body)}`);
    assert.equal(studioErrorSchema.parse(refused.body).error.code, "not_allowed_in_status");
    assert.equal((await row(siteId)).listedPublic, false, `${label}: nothing written`);
  }
});

test("the title follows PRD §5.2: editable live (draft or kept) and under review; refused otherwise", { skip }, async () => {
  const { updateOwnedSite } = await deps();
  const owner = await makeOwner();

  for (const seed of [{ kept: false }, { status: "under_review" as const }]) {
    const siteId = await seedSite(owner, seed);
    const outcome = await updateOwnedSite(siteId, { title: "Allowed" }, owner);
    assert.equal(outcome.status, 200, `${JSON.stringify(seed)}: ${JSON.stringify(outcome.body)}`);
  }

  for (const status of ["quarantined", "expired", "archived"] as const) {
    const siteId = await seedSite(owner, { status, kept: status === "expired" ? false : undefined });
    const before = await row(siteId);
    const outcome = await updateOwnedSite(siteId, { title: "Refused" }, owner);
    assert.equal(outcome.status, 409, `${status}: ${JSON.stringify(outcome.body)}`);
    assert.equal(studioErrorSchema.parse(outcome.body).error.code, "not_allowed_in_status");
    const after = await row(siteId);
    assert.equal(after.title, before.title, `${status}: nothing written`);
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
  }
});

test("another account's page, a removed page and a malformed id are the one not-found body", { skip }, async () => {
  const { updateOwnedSite } = await deps();
  const owner = await makeOwner();
  const stranger = await makeOwner();
  const theirs = await seedSite(owner);
  const removed = await seedSite(owner, { status: "removed" });

  const stolen = await updateOwnedSite(theirs, { title: "Hijack" }, stranger);
  const gone = await updateOwnedSite(removed, { title: "Back" }, owner);
  const malformed = await updateOwnedSite("not-a-uuid", { title: "x" }, owner);
  const absent = await updateOwnedSite(crypto.randomUUID(), { title: "x" }, owner);

  for (const outcome of [stolen, gone, malformed, absent]) assert.equal(outcome.status, 404);
  assert.deepEqual(stolen.body, absent.body, "not yours ≡ does not exist");
  assert.deepEqual(gone.body, absent.body);
  assert.deepEqual(malformed.body, absent.body);
  assert.equal((await row(theirs)).title, "Extracted at publish", "the stranger wrote nothing");
});

test("a body that names nothing, a title over the cap and a non-boolean flag are invalid_request", { skip }, async () => {
  const { updateOwnedSite } = await deps();
  const owner = await makeOwner();
  const siteId = await seedSite(owner);

  for (const [label, raw] of [
    ["empty", {}],
    ["too long", { title: "x".repeat(PAGE_TITLE_MAX_LENGTH + 1) }],
    ["not a boolean", { listedPublic: "yes" }],
    ["not an object", "title"],
  ] as const) {
    const outcome = await updateOwnedSite(siteId, raw, owner);
    assert.equal(outcome.status, 400, `${label}: ${JSON.stringify(outcome.body)}`);
    assert.equal(studioErrorSchema.parse(outcome.body).error.code, "invalid_request");
  }
  const tooLong = await updateOwnedSite(siteId, { title: "x".repeat(PAGE_TITLE_MAX_LENGTH + 1) }, owner);
  assert.equal(
    studioErrorSchema.parse(tooLong.body).error.message,
    `Titles can be up to ${PAGE_TITLE_MAX_LENGTH} characters.`,
  );
  assert.equal((await row(siteId)).title, "Extracted at publish");

  const exactly = await updateOwnedSite(siteId, { title: "x".repeat(PAGE_TITLE_MAX_LENGTH) }, owner);
  assert.equal(exactly.status, 200, "the cap itself is allowed");
});
