import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { limitsFor, kvManifestSchema } from "@kept/shared";
import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { versionPaths } from "../lib/db/queries/version-files";
import {
  fileSetSummary,
  formatBytes,
  PRO_SITE_BYTES_LINE,
  PUBLISHED_KEPT_TOAST,
  REPLACED_TOAST,
} from "../lib/sites/display";
import { pointerKey } from "../lib/storage/manifest";
import { r2Store } from "../lib/storage/r2";
import { buildZip } from "../lib/testing/zip-fixture";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { cleanup, holdPath, hydrated, newScope, signInAs, SKIP_OWNER_UI } from "./owner-fixtures";

/**
 * E08 task 010 — the studio publishes and replaces file sets (PRD §5.7, AC36,
 * AC37).
 *
 * A synthetic Vite-shaped `dist/` (index.html, hashed `assets/*.js|css`, an
 * image, and a `.DS_Store`) is written to this test's output folder and
 * dropped as a FOLDER through Chromium's own drag pipeline (`holdPath`), so the
 * studio walks it with `webkitGetAsEntry`, packs it store-only in the browser
 * and sends ONE multipart `archive`. AC36 closes on real Vite builds (task
 * 012): `examples/sites/field-notes` (a Vite + React SPA, inline) and
 * `examples/sites/orbit-garden` (Vite + three.js, 13.2 MiB, presigned).
 *
 * NO MOCKS: a real magic-link session, `POST /api/sites`, `POST
 * /api/sites/:id/replace` and a restore against dev Neon, R2 and KV; every
 * outcome is read back from Postgres and the manifest (its R2 slug pointer).
 *
 * ── DEV KV BUDGET (free plan: 1,000 writes + deletes a day) ─────────────────
 * One page for the whole file: publish (1) → replace (1) → restore (1) →
 * cleanup (1). The size refusal sends nothing. The presigned test adds one
 * publish and only runs once the dev bucket allows the browser's PUT. The real
 * Vite builds add two publishes and two cleanups.
 */
const scope = newScope();

/** The R2 dev bucket answers a browser's preflight for a presigned PUT (epic Human step 2). */
async function presignedPutAllowed(origin: string): Promise<boolean> {
  const url = await r2Store().presignPut(`uploads/e2e-cors/${crypto.randomUUID()}.zip`, 1, "application/zip", 60);
  const response = await fetch(url, {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": "PUT", "access-control-request-headers": "content-type" },
  });
  // Never log `url` — it is a bearer credential until it expires.
  return response.ok && response.headers.get("access-control-allow-origin") !== null;
}

/** A Vite-shaped `dist/` under this test's output folder; returns its path. */
async function writeViteDist(run: string, extra: Record<string, Uint8Array | string> = {}): Promise<string> {
  const root = test.info().outputPath(`vite-${run}`, "dist");
  const files: Record<string, Uint8Array | string> = {
    "index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>E08 vite ${run}</title><script type="module" crossorigin src="/assets/index-B${run}.js"></script><link rel="stylesheet" crossorigin href="/assets/index-C${run}.css"></head><body><div id="app"></div><img src="/vite.png" alt=""></body></html>\n`,
    [`assets/index-B${run}.js`]: `document.getElementById("app").textContent = "vite ${run}";\n`,
    [`assets/index-C${run}.css`]: `#app { font: 16px system-ui; }\n`,
    "vite.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]),
    ".DS_Store": "junk",
    ...extra,
  };
  for (const [path, body] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  return root;
}

/** The example sites (`examples/sites/`) — real builds, committed as built. */
const EXAMPLES_DIR = fileURLToPath(new URL("../../../examples/sites/", import.meta.url));

/** Every file under `dir`, as `/`-separated relative paths, in path order. */
async function sitePaths(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .sort();
}

/** Every studio write the screen sends from now on, with its body's content type. */
function watchWrites(page: Page) {
  const writes: { path: string; type: string }[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (path === "/api/sites" || path === "/api/uploads" || /^\/api\/sites\/[^/]+\/replace$/.test(path)) {
      writes.push({ path, type: request.headers()["content-type"] ?? "" });
    }
  });
  return writes;
}

async function currentVersion(siteId: string) {
  const [row] = await db
    .select({
      versionId: schema.siteVersions.id,
      fileCount: schema.siteVersions.fileCount,
      spa: schema.siteVersions.spa,
      sizeBytes: schema.siteVersions.sizeBytes,
    })
    .from(schema.sites)
    .innerJoin(schema.siteVersions, eq(schema.siteVersions.id, schema.sites.currentVersionId))
    .where(eq(schema.sites.id, siteId));
  return row!;
}

/**
 * The manifest's `spa`, read from its R2 slug pointer — byte-identical to the
 * KV value and written just before it (`writeManifest`, contract §5), so no
 * KV REST read (and no lint exception for `lib/storage/kv`) is needed.
 */
async function manifestSpa(slug: string): Promise<boolean> {
  const raw = await r2Store().get(pointerKey(slug));
  expect(raw, `a manifest is served for ${slug}`).not.toBeNull();
  return kvManifestSchema.parse(JSON.parse(raw!)).spa === true;
}

/** The pointer is written before the response; a short poll covers the refresh racing it. */
const MANIFEST_READ = { timeout: 15_000 };

async function openVersions(page: Page, siteId: string) {
  await page.goto(`/site/${siteId}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("tab", { name: "Versions" }).click();
  await expect(page.getByTestId("versions-panel")).toBeVisible();
}

test.describe("studio: folders, zips and the single-page-app flag", () => {
  test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
  test.describe.configure({ mode: "serial", timeout: LIVE_STACK_TIMEOUT * 2 });

  let email = "";
  let site: { id: string; slug: string; firstVersionId: string } | null = null;

  test.beforeAll(async () => {
    if (SKIP_OWNER_UI) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_OWNER_UI) return;
    await cleanup(scope);
    await closeDb();
  });

  test("AC36 (synthetic Vite dist): a dropped folder is packed in the browser and published as one set — thumbnail, not a preview", async ({
    page,
    baseURL,
  }) => {
    const signedIn = await signInAs(page, baseURL!, scope);
    email = signedIn.email;
    const run = crypto.randomUUID().slice(0, 8);
    const dist = await writeViteDist(run);

    await page.goto("/dashboard");
    await hydrated(page);
    const zone = page.getByRole("button", { name: /Drop an HTML file, a folder or a \.zip/ });
    await expect(zone).toBeVisible();
    // AC37: the checkbox under the zone, off by default, sent with the publish.
    const spa = page.getByTestId("spa-checkbox");
    await expect(spa).not.toBeChecked();
    await spa.check();
    const writes = watchWrites(page);

    await (await holdPath(page, zone, dist)).drop();

    const toast = page.locator("[data-sonner-toast]").filter({ hasText: PUBLISHED_KEPT_TOAST });
    await expect(toast).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    // D7: the OS junk is skipped, and said once.
    await expect(toast).toContainText("Published. Skipped 1 file (");
    await expect(toast).toContainText(".DS_Store");

    expect(writes, "one request, one multipart archive").toHaveLength(1);
    expect(writes[0]!.path).toBe("/api/sites");
    expect(writes[0]!.type).toMatch(/^multipart\/form-data; boundary=/);

    const [row] = await db
      .select({ id: schema.sites.id, slug: schema.sites.slug })
      .from(schema.sites)
      .where(eq(schema.sites.ownerId, signedIn.userId));
    expect(row, "the account owns the published page").toBeDefined();
    scope.siteIds.push(row!.id);
    scope.slugs.add(row!.slug);

    const version = await currentVersion(row!.id);
    site = { id: row!.id, slug: row!.slug, firstVersionId: version.versionId };
    console.log(`[studio-multi-file] published ${row!.slug}: ${version.fileCount} files, ${version.sizeBytes} B, spa ${version.spa}`);
    expect(version.fileCount).toBe(4);
    expect(version.spa, "the checkbox's value reached the version").toBe(true);
    // The shared top folder is stripped (D7); paths are the build's own.
    expect((await versionPaths(db, [version.versionId])).get(version.versionId)).toEqual([
      `assets/index-B${run}.js`,
      `assets/index-C${run}.css`,
      "index.html",
      "vite.png",
    ]);
    await expect.poll(() => manifestSpa(row!.slug), MANIFEST_READ).toBe(true);

    // The card: the OG thumbnail, and no hover preview of a multi-file page.
    await page.goto("/dashboard");
    await hydrated(page);
    const card = page.locator(`[data-testid="home-card"][data-site-id="${row!.id}"]`);
    await card.getByTestId("card-thumbnail").hover();
    await page.waitForTimeout(1_500);
    await expect(card.getByTestId("card-preview")).toHaveCount(0);

    // Page detail: "{n} files · {size}" and Open ↗ in place of the srcdoc frame.
    await page.goto(`/site/${row!.id}`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("iframe")).toHaveCount(0);
    await expect(page.getByTestId("file-summary")).toHaveText(fileSetSummary(4, version.sizeBytes));
    await expect(page.getByTestId("thumbnail-preview").getByRole("link", { name: /Open ↗/ })).toHaveAttribute(
      "rel",
      /noopener/,
    );
  });

  test("AC37: a replace shows the current SPA value and sends the new one; a restore brings spa back", async ({
    page,
    baseURL,
  }) => {
    test.skip(site === null, "the publish above did not land");
    await signInAs(page, baseURL!, scope, email);
    const { id, slug, firstVersionId } = site!;

    await openVersions(page, id);
    const spa = page.getByTestId("spa-checkbox");
    await expect(spa, "shown with the current version's value").toBeChecked();
    await expect(page.getByTestId("version-files")).toHaveText(/^4 files · /);
    await spa.uncheck();

    // A .zip dropped as it is: never re-packed.
    const zipPath = test.info().outputPath("replace", "site.zip");
    await mkdir(dirname(zipPath), { recursive: true });
    await writeFile(
      zipPath,
      buildZip([
        { name: "index.html", data: `<!doctype html><title>E08 zip ${slug}</title><script src="app.js"></script>` },
        { name: "app.js", data: "console.log('zip');" },
      ]),
    );
    const writes = watchWrites(page);
    const zone = page.getByRole("button", { name: /Drop an HTML file, a folder or a \.zip/ });
    await (await holdPath(page, zone, zipPath)).drop();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: REPLACED_TOAST })).toBeVisible({
      timeout: LIVE_STACK_TIMEOUT,
    });
    expect(writes.map((write) => write.path)).toEqual([`/api/sites/${id}/replace`]);
    expect(writes[0]!.type).toMatch(/^multipart\/form-data; boundary=/);

    const replaced = await currentVersion(id);
    expect(replaced.versionId).not.toBe(firstVersionId);
    expect(replaced.fileCount).toBe(2);
    expect(replaced.spa).toBe(false);
    await expect.poll(() => manifestSpa(slug), MANIFEST_READ).toBe(false);
    // The panel re-reads: the checkbox follows the version now served.
    await expect(spa).not.toBeChecked();
    await expect(page.getByTestId("version-row").first().getByTestId("version-files")).toHaveText(/^2 files · /);

    // Restore the SPA version (edge case 12: the manifest's flags are the version's).
    await page
      .locator(`[data-testid="version-row"][data-version-id="${firstVersionId}"]`)
      .getByTestId("restore-button")
      .click();
    await page.getByTestId("restore-dialog").getByRole("button", { name: "Restore" }).click();
    await expect(page.getByTestId("restore-dialog")).toBeHidden({ timeout: LIVE_STACK_TIMEOUT });

    const restored = await currentVersion(id);
    expect(restored.versionId).toBe(firstVersionId);
    expect(restored.spa).toBe(true);
    await expect.poll(() => manifestSpa(slug), { ...MANIFEST_READ, message: "restore → manifest spa: true" }).toBe(true);
    await expect(spa, "and the checkbox reflects it").toBeChecked();
  });

  test("a Free set past 20 MB is refused before any request — §8's sentence and the locked row", async ({
    page,
    baseURL,
  }) => {
    // A fresh account: its empty Pages home has the zone and its Browse folder.
    await signInAs(page, baseURL!, scope);
    const run = crypto.randomUUID().slice(0, 8);
    const max = limitsFor("free").siteBytes;
    const big = new Uint8Array(max); // with the rest of the dist, past the cap
    const dist = await writeViteDist(run, { "assets/big.bin": big });

    await page.goto("/dashboard");
    await hydrated(page);
    const writes = watchWrites(page);
    // The webkitdirectory input — the zone's "Browse folder".
    await page.getByTestId("folder-input").setInputFiles(dist);

    const error = page.getByTestId("publish-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText(
      new RegExp(`^This site is [\\d.]+ MB\\. Free sites can be up to ${formatBytes(max).replace(".", "\\.")}\\.`),
    );
    await expect(error).toContainText(PRO_SITE_BYTES_LINE);
    await page.waitForTimeout(500);
    expect(writes, "nothing was sent").toEqual([]);
    await expect(page.getByTestId("mint-card")).toHaveCount(0);
  });

  test("past one inline request, a set goes through the presigned upload with progress", async ({
    page,
    baseURL,
  }) => {
    test.skip(
      !(await presignedPutAllowed(new URL(baseURL!).origin)),
      "the dev bucket has no CORS rule for the browser's PUT yet (epic Human step 2) — re-run in task 012",
    );
    const { userId } = await signInAs(page, baseURL!, scope);
    const run = crypto.randomUUID().slice(0, 8);
    // 12 MB of real bytes: past INLINE_BODY_MAX_BYTES, within Free's 20 MB, and
    // split in two so neither file passes Free's 10 MB per-file cap.
    const dist = await writeViteDist(run, {
      "assets/model-a.bin": new Uint8Array(6 * 1024 * 1024).fill(7),
      "assets/model-b.bin": new Uint8Array(6 * 1024 * 1024).fill(8),
    });

    await page.goto("/dashboard");
    await hydrated(page);
    const writes = watchWrites(page);
    await page.getByTestId("folder-input").setInputFiles(dist);
    await expect(page.getByTestId("upload-progress")).toHaveAttribute("data-phase", "uploading", {
      timeout: LIVE_STACK_TIMEOUT,
    });
    await expect(page.getByText(PUBLISHED_KEPT_TOAST)).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    expect(writes.map((write) => write.path)).toEqual(["/api/uploads", "/api/sites"]);
    expect(writes[1]!.type).toMatch(/^application\/json/);

    const [row] = await db
      .select({ id: schema.sites.id, slug: schema.sites.slug })
      .from(schema.sites)
      .where(eq(schema.sites.ownerId, userId));
    scope.siteIds.push(row!.id);
    scope.slugs.add(row!.slug);
    expect((await currentVersion(row!.id)).fileCount).toBe(6);
  });

  test("AC36 (real Vite builds): field-notes dropped as a folder publishes inline as an SPA; orbit-garden goes presigned", async ({
    page,
    baseURL,
  }) => {
    test.skip(
      !(await presignedPutAllowed(new URL(baseURL!).origin)),
      "the dev bucket has no CORS rule for the browser's PUT (epic Human step 2)",
    );
    const builds = [
      { slug: "field-notes", spa: true, writes: ["/api/sites"], drop: true },
      { slug: "orbit-garden", spa: false, writes: ["/api/uploads", "/api/sites"], drop: false },
    ];

    for (const build of builds) {
      // A fresh account each: an empty Pages home has the zone, the checkbox and Browse folder.
      const { userId } = await signInAs(page, baseURL!, scope);
      const dir = join(EXAMPLES_DIR, build.slug);
      const paths = await sitePaths(dir);

      await page.goto("/dashboard");
      await hydrated(page);
      const zone = page.getByRole("button", { name: /Drop an HTML file, a folder or a \.zip/ });
      await expect(zone).toBeVisible();
      if (build.spa) await page.getByTestId("spa-checkbox").check();
      const writes = watchWrites(page);

      if (build.drop) await (await holdPath(page, zone, dir)).drop();
      else await page.getByTestId("folder-input").setInputFiles(dir);
      if (!build.drop) {
        await expect(page.getByTestId("upload-progress")).toHaveAttribute("data-phase", "uploading", {
          timeout: LIVE_STACK_TIMEOUT,
        });
      }
      await expect(page.locator("[data-sonner-toast]").filter({ hasText: PUBLISHED_KEPT_TOAST })).toBeVisible({
        timeout: LIVE_STACK_TIMEOUT,
      });
      expect(writes.map((write) => write.path), build.slug).toEqual(build.writes);

      const [row] = await db
        .select({ id: schema.sites.id, slug: schema.sites.slug })
        .from(schema.sites)
        .where(eq(schema.sites.ownerId, userId));
      expect(row, `${build.slug}: the account owns the published page`).toBeDefined();
      scope.siteIds.push(row!.id);
      scope.slugs.add(row!.slug);

      const version = await currentVersion(row!.id);
      console.log(`[studio-multi-file] ${build.slug} → ${row!.slug}: ${version.fileCount} files, ${version.sizeBytes} B, spa ${version.spa}`);
      expect(version.fileCount).toBe(paths.length);
      expect(version.spa).toBe(build.spa);
      expect((await versionPaths(db, [version.versionId])).get(version.versionId), "the build's own paths").toEqual(paths);
      await expect.poll(() => manifestSpa(row!.slug), MANIFEST_READ).toBe(build.spa);

      // Page detail: "{n} files · {size}" and Open ↗ in place of the srcdoc frame.
      await page.goto(`/site/${row!.id}`);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("iframe")).toHaveCount(0);
      await expect(page.getByTestId("file-summary")).toHaveText(fileSetSummary(paths.length, version.sizeBytes));
      await expect(page.getByTestId("thumbnail-preview").getByRole("link", { name: /Open ↗/ })).toBeVisible();
    }
  });
});
