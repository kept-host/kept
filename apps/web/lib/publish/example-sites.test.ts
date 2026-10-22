/**
 * E08 task 012 — the seven example sites (`examples/sites/`, indexed by
 * `examples/sites.json`) publish through the real reader and the real pipeline,
 * as a signed-in Free owner. They are the epic's fixtures (Arun, 2026-10-22):
 * real multi-file builds — a Vite SPA, a three.js scene past the 10 MB inline
 * cap, a game with audio, an Eleventy site with a custom 404, a WebAssembly
 * toy, a data page, a 94-file portfolio.
 *
 * NO MOCKS. Each site goes the way the studio sends a site larger than one
 * inline request (D5): zipped under one top folder (D7 strips it), PUT to the
 * owner's `uploads/` prefix through a real presigned URL, read back by
 * `readFileSet` from `{ upload_id, spa }`, and published by `publishOwnedSite`
 * — the function `POST /api/sites` calls, which also consumes the upload. So
 * Postgres, R2, KV and the edge purge all genuinely run. One path for all
 * seven: orbit-garden (13.2 MiB) cannot travel inline, and the others prove
 * the same path on smaller sets.
 *
 * Per site: the stored file count is `sites.json`'s `files`; the manifest's
 * `spa` / `has404` match `sites.json`'s `spa` and whether the folder ships a
 * `404.html`; and `site_version_files` holds exactly the folder's files, each
 * with its size and SHA-256 from disk.
 *
 * KV: one write per site (7), one delete per site in `after`.
 *
 * The reader spools zips under `os.tmpdir()/kept-fileset-*`, and
 * `fileset/read.test.ts` counts those directories while node runs test files in
 * parallel processes. This file points its own process's `TMPDIR` at a private
 * directory, so its spools never race that count, and asserts its own spools
 * are gone.
 *
 * `examples/` is gitignored — the sites live only on Arun's machine (2026-10-22)
 * — so both tests SKIP, saying so, when `examples/sites.json` is absent (CI).
 * The publishing test also SKIPS without dev credentials. Never prints an
 * upload URL.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { kvManifestSchema, UPLOAD_CONTENT_TYPE } from "@kept/shared";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";

import { closeDb, db } from "../db";
import { siteObjectKeys, versionFiles } from "../db/queries/version-files";
import { profiles, sites, user } from "../db/schema";
import { pointerKey } from "../storage/manifest";
import { publishOwnedSite } from "../sites/owner-routes";
import { r2Store } from "../storage/r2";
import { buildZip } from "../testing/zip-fixture";
import { uploadObjectKey } from "../uploads/upload";
import { readFileSet } from "./fileset/read";
import { TEMP_PREFIX } from "./fileset/zip";

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
  missing.length > 0 ? `dev credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local` : false;

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = join(REPO_ROOT, "examples", "sites.json");
const noExamples: string | false = existsSync(INDEX)
  ? false
  : "examples/ is gitignored and absent here — run locally with the example sites in place";

interface ExampleSite {
  slug: string;
  path: string;
  spa: boolean;
  files: number;
}

const EXAMPLES: ExampleSite[] = noExamples ? [] : JSON.parse(readFileSync(INDEX, "utf8"));

const SPOOL_DIR = mkdtempSync(join(tmpdir(), "kept-examples-"));
process.env.TMPDIR = SPOOL_DIR;

const publisher = { ip: "127.0.0.1", userAgent: "kept-e08-012-examples/1.0" };
const createdUsers = new Set<string>();
const createdSites = new Set<string>();
const publishedSlugs = new Set<string>();
const uploadKeys = new Set<string>();

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Every file under `dir`, as `/`-separated paths relative to it, in path order. */
function walk(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .sort();
}

async function makeFreeAccount(): Promise<string> {
  const id = crypto.randomUUID();
  const email = `e08-012-${id.slice(0, 12)}@kept-e08-012.invalid`;
  await db.insert(user).values({ id, name: "E08-012 example sites", email, emailVerified: true });
  await db.insert(profiles).values({ id, email, plan: "free" });
  createdUsers.add(id);
  return id;
}

/** PUT `bytes` as `profileId`'s upload through a real presigned URL; the upload's id. */
async function upload(profileId: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const id = crypto.randomUUID();
  const key = uploadObjectKey(profileId, id);
  uploadKeys.add(key);
  const url = await r2Store().presignPut(key, bytes.length, UPLOAD_CONTENT_TYPE, 120);
  const res = await fetch(url, { method: "PUT", headers: { "content-type": UPLOAD_CONTENT_TYPE }, body: bytes });
  await res.body?.cancel();
  assert.equal(res.status, 200, "the presigned PUT is accepted");
  return id;
}

after(async () => {
  rmSync(SPOOL_DIR, { recursive: true, force: true });
  if (skip) return;
  await (await import("../testing/served-manifests")).removeServedManifests(publishedSlugs);
  await (await import("../testing/pending-purges")).clearPendingPurges(publishedSlugs, createdSites);
  const store = r2Store();
  for (const siteId of createdSites) {
    await store.deleteMany(await siteObjectKeys(db, siteId)).catch(() => undefined);
  }
  if (uploadKeys.size > 0) await store.deleteMany([...uploadKeys]).catch(() => undefined);
  if (createdSites.size > 0) await db.delete(sites).where(inArray(sites.id, [...createdSites]));
  // `profiles` cascades off `user.id`.
  if (createdUsers.size > 0) await db.delete(user).where(inArray(user.id, [...createdUsers]));
  await closeDb();
});

test("examples/sites.json indexes every example folder", { skip: noExamples }, () => {
  assert.ok(EXAMPLES.length > 0, "examples/sites.json lists no sites");
  const folders = readdirSync(join(REPO_ROOT, "examples", "sites"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(EXAMPLES.map((site) => site.slug).sort(), folders);
  for (const site of EXAMPLES) {
    assert.equal(site.path, `examples/sites/${site.slug}`, site.slug);
    assert.equal(walk(join(REPO_ROOT, site.path)).length, site.files, `${site.slug}: files on disk`);
  }
});

test("every example site publishes through readFileSet and publishOwnedSite as a Free owner", { skip: noExamples || skip }, async () => {
  const owner = await makeFreeAccount();

  for (const site of EXAMPLES) {
    const dir = join(REPO_ROOT, site.path);
    const paths = walk(dir);
    const disk = new Map(paths.map((path) => [path, new Uint8Array(readFileSync(join(dir, path)))]));

    // One top folder, as a zipped build folder arrives; D7 strips it.
    const zip = buildZip(paths.map((path) => ({ name: `${site.slug}/${path}`, data: disk.get(path)!, deflate: true })));
    const uploadId = await upload(owner, zip);
    const request = new Request("https://app.kept.test/api/sites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ upload_id: uploadId, spa: site.spa }),
    });
    const set = await readFileSet(request, { plan: "free", uploaderId: owner });

    const outcome = await publishOwnedSite(set, owner, publisher);
    assert.equal(outcome.ok, true, `${site.slug}: ${outcome.ok ? "" : JSON.stringify(outcome.body)}`);
    if (!outcome.ok) continue;
    assert.equal(outcome.status, 201, `${site.slug}: a new page`);
    const { id: siteId, slug } = outcome.body.site;
    createdSites.add(siteId);
    publishedSlugs.add(slug);

    const [row] = await db.select().from(sites).where(eq(sites.id, siteId));
    assert.ok(row?.currentVersionId, `${site.slug}: the site points at a version`);
    assert.equal(row.ownerId, owner);

    // site_version_files: exactly the folder's files, sizes and digests from disk.
    const stored = await versionFiles(db, row.currentVersionId);
    assert.equal(stored.length, site.files, `${site.slug}: stored file count`);
    assert.deepEqual(
      stored.map((file) => file.path),
      paths,
      `${site.slug}: stored paths are the folder's paths, top folder stripped`,
    );
    for (const file of stored) {
      const bytes = disk.get(file.path)!;
      assert.equal(file.sizeBytes, bytes.length, `${site.slug}/${file.path}: size`);
      assert.equal(file.sha256, sha256(bytes), `${site.slug}/${file.path}: sha256`);
    }
    assert.equal(row.sizeBytes, paths.reduce((sum, path) => sum + disk.get(path)!.length, 0), `${site.slug}: total bytes`);

    // The manifest, from the pointer `writeManifest` wrote with the same bytes as KV.
    const pointer = await r2Store().get(pointerKey(slug));
    assert.ok(pointer, `${site.slug}: the manifest pointer exists`);
    const manifest = kvManifestSchema.parse(JSON.parse(pointer));
    assert.equal(manifest.versionId, row.currentVersionId);
    assert.equal(manifest.spa === true, site.spa, `${site.slug}: manifest spa`);
    assert.equal(manifest.has404 === true, existsSync(join(dir, "404.html")), `${site.slug}: manifest has404`);

    // Used once: publishOwnedSite consumed the upload.
    assert.equal(await r2Store().get(uploadObjectKey(owner, uploadId)), null, `${site.slug}: the upload is consumed`);
  }

  assert.equal(readdirSync(SPOOL_DIR).filter((name) => name.startsWith(TEMP_PREFIX)).length, 0, "every spool is removed");
});
