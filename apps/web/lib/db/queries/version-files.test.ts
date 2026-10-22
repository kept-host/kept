/**
 * `site_version_files` queries — E08-multi-file-sites task 002.
 *
 * NO MOCKS (project rule): every assertion runs against the real dev Neon
 * branch with `0010` applied. The chunked insert, the ordering, the `site_id`
 * scoping and the `ON DELETE CASCADE` are database behaviour.
 *
 * Touches Postgres only — no R2 object, no KV write. The scratch site and its
 * versions are deleted in `after` (its files cascade with them).
 *
 * SKIPS when `DATABASE_URL` is absent (CI on fork PRs has no secrets). Run with
 *
 *   pnpm --filter @kept/web exec tsx --test lib/db/queries/version-files.test.ts
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const createdSites = new Set<string>();

async function deps() {
  const { eq, inArray } = await import("drizzle-orm");
  const { closeDb, db } = await import("../index");
  const { sites, siteVersionFiles, siteVersions } = await import("../schema");
  const { siteObjectKey } = await import("../../storage/r2");
  const queries = await import("./version-files");
  return { eq, inArray, closeDb, db, sites, siteVersionFiles, siteVersions, siteObjectKey, ...queries };
}

async function makeSite(): Promise<string> {
  const { db, sites } = await deps();
  const id = crypto.randomUUID();
  await db.insert(sites).values({
    id,
    slug: `e08-002-${id.slice(0, 12)}`,
    status: "live",
    region: "auto",
    publisherHash: "e08-002-drill",
    contentHash: "e08-002",
    sizeBytes: 0,
  });
  createdSites.add(id);
  return id;
}

async function makeVersion(siteId: string): Promise<string> {
  const { db, siteVersions, siteObjectKey } = await deps();
  const id = crypto.randomUUID();
  await db.insert(siteVersions).values({
    id,
    siteId,
    r2Key: siteObjectKey(siteId, id, "index.html"),
    contentHash: "e08-002",
    sizeBytes: 0,
  });
  return id;
}

/** `count` entries with zero-padded paths, so path order is creation order. */
function entries(count: number, prefix = "f") {
  return Array.from({ length: count }, (_, i) => ({
    path: `${prefix}/${String(i).padStart(5, "0")}.txt`,
    sizeBytes: i,
    sha256: i.toString(16).padStart(64, "0"),
  }));
}

after(async () => {
  if (skipLive) return;
  const { closeDb, db, inArray, sites } = await deps();
  if (createdSites.size > 0) {
    // `site_versions` cascades from `sites`, `site_version_files` from them.
    await db.delete(sites).where(inArray(sites.id, [...createdSites]));
  }
  await closeDb();
});

test(
  "insertVersionFiles stores 5,000 rows (chunked) and every reader returns them",
  { skip: skipLive },
  async () => {
    const { db, insertVersionFiles, siteObjectKey, siteObjectKeys, versionFileKeys, versionFiles, versionPaths } =
      await deps();
    const siteId = await makeSite();
    const big = await makeVersion(siteId);
    const small = await makeVersion(siteId);
    const bigEntries = entries(5000);
    const smallEntries = [
      { path: "index.html", sizeBytes: 10, sha256: "a".repeat(64) },
      { path: "assets/app.js", sizeBytes: 20, sha256: "b".repeat(64) },
    ];

    await insertVersionFiles(db, big, bigEntries);
    await db.transaction((tx) => insertVersionFiles(tx, small, smallEntries));

    const files = await versionFiles(db, big);
    assert.equal(files.length, 5000, "all 5,000 rows across chunks");
    assert.deepEqual(files, bigEntries, "path order, exact sizes and hashes");
    assert.deepEqual(
      await versionFiles(db, small),
      [smallEntries[1], smallEntries[0]],
      "ordered by path: assets/app.js before index.html",
    );

    const unknown = crypto.randomUUID();
    const paths = await versionPaths(db, [big, small, unknown]);
    assert.equal(paths.get(big)?.length, 5000);
    assert.deepEqual(paths.get(small), ["assets/app.js", "index.html"]);
    assert.deepEqual(paths.get(unknown), [], "an id with no rows maps to an empty list");
    assert.equal((await versionPaths(db, [])).size, 0);

    const smallKeys = smallEntries.map((e) => siteObjectKey(siteId, small, e.path)).sort();
    assert.deepEqual((await versionFileKeys(db, siteId, [small])).sort(), smallKeys);
    assert.equal((await versionFileKeys(db, siteId, [big, small])).length, 5002);
    assert.deepEqual(await versionFileKeys(db, siteId, []), []);
    assert.ok(
      (await versionFileKeys(db, siteId, [small])).every((key) => key.startsWith(`sites/${siteId}/${small}/`)),
      "keys use the sites/{siteId}/{versionId}/{path} layout",
    );

    const all = await siteObjectKeys(db, siteId);
    assert.equal(all.length, 5002, "every file of every version");
    assert.ok(all.includes(siteObjectKey(siteId, big, "f/04999.txt")));
  },
);

test(
  "versionFileKeys is scoped by site: another site's version id names nothing",
  { skip: skipLive },
  async () => {
    const { db, insertVersionFiles, siteObjectKeys, versionFileKeys } = await deps();
    const siteA = await makeSite();
    const siteB = await makeSite();
    const versionB = await makeVersion(siteB);
    await insertVersionFiles(db, versionB, entries(3));

    assert.deepEqual(await versionFileKeys(db, siteA, [versionB]), []);
    assert.deepEqual(await siteObjectKeys(db, siteA), []);
    assert.equal((await versionFileKeys(db, siteB, [versionB])).length, 3);
  },
);

test(
  "deleting a version cascades to its site_version_files rows",
  { skip: skipLive },
  async () => {
    const { db, eq, insertVersionFiles, siteVersionFiles, siteVersions, versionFiles } = await deps();
    const siteId = await makeSite();
    const versionId = await makeVersion(siteId);
    await insertVersionFiles(db, versionId, entries(12));
    assert.equal((await versionFiles(db, versionId)).length, 12);

    await db.delete(siteVersions).where(eq(siteVersions.id, versionId));

    const left = await db
      .select({ path: siteVersionFiles.path })
      .from(siteVersionFiles)
      .where(eq(siteVersionFiles.versionId, versionId));
    assert.equal(left.length, 0, "ON DELETE CASCADE removed every file row");
  },
);
