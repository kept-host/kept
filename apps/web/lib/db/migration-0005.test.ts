/**
 * Migration `0005_creator_studio` drills — E06-creator-studio task 002.
 *
 * NO MOCKS (project rule). Every assertion runs against the real dev Neon
 * branch with `0005` applied: the partial `sites_slug_key`, the column defaults
 * and the foreign keys are database behaviour, and only a real database can
 * prove a predicate or an `ON DELETE` clause exists.
 *
 * The drills SKIP when `DATABASE_URL` is absent: CI runs `pnpm test` on fork PRs
 * with no cloud secrets. Run them locally with
 *
 *   pnpm --filter @kept/web exec tsx --test lib/db/migration-0005.test.ts
 *
 * Every row created here is deleted in `after`.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import type { SiteStatus } from "@kept/shared";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const createdSites = new Set<string>();
const createdUsers = new Set<string>();
const createdHolds = new Set<string>();
const createdEvents = new Set<string>();

async function schema() {
  return import("./schema");
}

async function client() {
  const { db } = await import("./index");
  return db;
}

function drillSlug(): string {
  return `e06cs-002-${crypto.randomUUID().slice(0, 12)}`;
}

async function makeSite(
  slug: string = drillSlug(),
  status: SiteStatus = "live",
): Promise<{ id: string; slug: string }> {
  const db = await client();
  const { sites } = await schema();
  const id = crypto.randomUUID();
  await db.insert(sites).values({
    id,
    slug,
    status,
    region: "auto",
    publisherHash: "e06cs-002-drill",
    contentHash: "e06cs-002",
    sizeBytes: 256,
  });
  createdSites.add(id);
  return { id, slug };
}

after(async () => {
  if (skipLive) return;
  const db = await client();
  const { nameEvents, nameHolds, sites, user } = await schema();
  const { inArray } = await import("drizzle-orm");

  if (createdHolds.size > 0) {
    await db.delete(nameHolds).where(inArray(nameHolds.name, [...createdHolds]));
  }
  if (createdEvents.size > 0) {
    await db.delete(nameEvents).where(inArray(nameEvents.id, [...createdEvents]));
  }
  if (createdSites.size > 0) {
    // `site_versions.site_id` cascades, so the versions go with the sites.
    await db.delete(sites).where(inArray(sites.id, [...createdSites]));
  }
  if (createdUsers.size > 0) {
    // `profiles.id` cascades from `user`.
    await db.delete(user).where(inArray(user.id, [...createdUsers]));
  }
  await db.$client.end();
});

test(
  "AC24 (index half): archived and removed rows release their slug; two non-final rows still collide on sites_slug_key",
  { skip: skipLive },
  async () => {
    const { isSlugCollision } = await import("./queries/publish");
    const slug = drillSlug();

    await makeSite(slug, "archived");
    await makeSite(slug, "removed");
    await makeSite(slug, "live");
    console.log(`[migration-0005] archived, removed and live rows share slug ${slug}`);

    // `expired` is not final: the expired page still owns its name.
    const second = makeSite(slug, "expired");
    await assert.rejects(second, (err: unknown) => {
      console.log(`[migration-0005] second non-final insert rejected: ${String(err)}`);
      assert.equal(
        isSlugCollision(err),
        true,
        "the failure must be a 23505 on the constraint named sites_slug_key",
      );
      return true;
    });
  },
);

test(
  "site_versions: activated_at defaults to the insert's now() (= created_at) and published_via defaults to web",
  { skip: skipLive },
  async () => {
    const db = await client();
    const { siteVersions } = await schema();
    const { id: siteId } = await makeSite();
    const versionId = crypto.randomUUID();

    const [version] = await db
      .insert(siteVersions)
      .values({
        id: versionId,
        siteId,
        region: "auto",
        r2Key: `sites/${siteId}/${versionId}/index.html`,
        contentHash: "e06cs-002",
        sizeBytes: 256,
      })
      .returning({
        createdAt: siteVersions.createdAt,
        activatedAt: siteVersions.activatedAt,
        publishedVia: siteVersions.publishedVia,
      });

    assert.ok(version, "the version row was written");
    console.log(
      `[migration-0005] version created_at=${version.createdAt.toISOString()} activated_at=${version.activatedAt.toISOString()} published_via=${version.publishedVia}`,
    );
    assert.equal(version.activatedAt.getTime(), version.createdAt.getTime());
    assert.equal(version.publishedVia, "web");
  },
);

test(
  "sites: title_source, name_kind and listed_public take their defaults",
  { skip: skipLive },
  async () => {
    const db = await client();
    const { sites } = await schema();
    const { eq } = await import("drizzle-orm");
    const { id } = await makeSite();

    const [row] = await db
      .select({
        titleSource: sites.titleSource,
        nameKind: sites.nameKind,
        listedPublic: sites.listedPublic,
      })
      .from(sites)
      .where(eq(sites.id, id));

    assert.deepEqual(row, { titleSource: "html", nameKind: "generated", listedPublic: false });
  },
);

test(
  "bug 4 (storage half): a Drizzle update that never names updatedAt still moves updated_at",
  { skip: skipLive },
  async () => {
    const db = await client();
    const { sites } = await schema();
    const { eq } = await import("drizzle-orm");
    const { id } = await makeSite();

    const stale = new Date("2020-01-01T00:00:00Z");
    await db.update(sites).set({ updatedAt: stale }).where(eq(sites.id, id));

    await db.update(sites).set({ sizeBytes: 512 }).where(eq(sites.id, id));

    const [row] = await db
      .select({ updatedAt: sites.updatedAt })
      .from(sites)
      .where(eq(sites.id, id));
    assert.ok(row, "the drill row exists");
    console.log(`[migration-0005] updated_at after an update without it: ${row.updatedAt.toISOString()}`);
    assert.ok(
      row.updatedAt.getTime() > stale.getTime(),
      `updated_at stayed at ${row.updatedAt.toISOString()}; sites.updatedAt needs $onUpdate`,
    );
  },
);

test(
  "name_holds.user_id and name_events.user_id go NULL when the account is deleted; the rows survive",
  { skip: skipLive },
  async () => {
    const db = await client();
    const { nameEvents, nameHolds, profiles, user } = await schema();
    const { eq } = await import("drizzle-orm");

    const userId = crypto.randomUUID();
    await db.insert(user).values({
      id: userId,
      name: "E06cs-002 drill",
      email: `e06cs-002-${userId}@kept.invalid`,
      emailVerified: true,
    });
    await db.insert(profiles).values({ id: userId, email: `e06cs-002-${userId}@kept.invalid` });
    createdUsers.add(userId);

    const siteId = crypto.randomUUID();
    const heldName = drillSlug();
    await db.insert(nameHolds).values({
      name: heldName,
      userId,
      siteId,
      reason: "account_deleted",
      heldUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    });
    createdHolds.add(heldName);

    const [event] = await db
      .insert(nameEvents)
      .values({ userId, siteId, oldName: drillSlug(), newName: heldName })
      .returning({ id: nameEvents.id });
    assert.ok(event, "the name event was written");
    createdEvents.add(event.id);

    // The account-deletion path: `user` → `profiles` cascades, and both name
    // tables reference `profiles.id` with ON DELETE SET NULL.
    await db.delete(user).where(eq(user.id, userId));
    createdUsers.delete(userId);

    const [hold] = await db
      .select({ userId: nameHolds.userId })
      .from(nameHolds)
      .where(eq(nameHolds.name, heldName));
    const [history] = await db
      .select({ userId: nameEvents.userId })
      .from(nameEvents)
      .where(eq(nameEvents.id, event.id));

    console.log(`[migration-0005] after account delete: hold=${JSON.stringify(hold)} event=${JSON.stringify(history)}`);
    assert.deepEqual(hold, { userId: null });
    assert.deepEqual(history, { userId: null });
  },
);
