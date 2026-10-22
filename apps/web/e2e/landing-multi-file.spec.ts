import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { INLINE_BODY_MAX_BYTES } from "@kept/shared";
import { downloadZip } from "client-zip";
import { expect, test, type Page } from "@playwright/test";

import { inlineTooLarge } from "../lib/publish/fileset/copy";

import {
  deleteDrafts,
  probeEdge,
  servingDomain,
  SKIP_LIVE_PUBLISH,
  trackDrafts,
} from "./live-publish";
import { holdPath } from "./owner-fixtures";

/**
 * E08 task 011 — the landing hero and the `/p` replace take a folder or a
 * `.zip` (PRD §5.8, AC39), inline only (Q-new-2: ≤ `INLINE_BODY_MAX_BYTES`).
 *
 * Every drop goes through Chromium's own drag pipeline (`holdPath`), so the
 * engine walks a dropped folder with `webkitGetAsEntry` exactly as a drag from
 * the desktop does, packs it store-only in the browser and sends ONE multipart
 * `archive`. The `.zip` is built here with `client-zip`. No mocks: the real
 * `POST /api/publish` and `POST /api/anon/:token/replace` against dev Neon, R2
 * and KV, and the published set is read back off the deployed dev Worker.
 *
 * The closed half (a folder or `.zip` drop opens the waitlist, sends nothing)
 * is `waitlist.closed.spec.ts`.
 *
 * ── DEV KV BUDGET (free plan: 1,000 writes + deletes a day) ─────────────────
 * Two publishes (zip, folder), one replace, two cleanup deletes.
 */

/** One tile face per engine phase; the engine crossfades them by opacity. */
const face = (page: Page, name: "idle" | "minting" | "live" | "error") =>
  page.locator(`[data-face="${name}"]`);

/** The host written into the live label, once the tile is live. */
const liveLabel = (page: Page) => face(page, "live").locator("span").last();

const run = () => crypto.randomUUID().slice(0, 8);

/** A two-file site: a page and the stylesheet it links. */
function siteFiles(marker: string): Record<string, string> {
  return {
    "index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marker}</title><link rel="stylesheet" href="assets/site.css"></head><body><h1>${marker}</h1></body></html>\n`,
    "assets/site.css": `h1 { font: 600 32px system-ui; } /* ${marker} */\n`,
  };
}

/** `files` as a folder under this test's output directory; returns its path. */
async function writeFolder(name: string, files: Record<string, string>): Promise<string> {
  const root = test.info().outputPath(name);
  for (const [path, body] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  return root;
}

/** `files` as a `.zip` built with `client-zip`; returns its path. */
async function writeZip(name: string, files: Record<string, string>): Promise<string> {
  const zip = await downloadZip(
    Object.entries(files).map(([path, input]) => ({ name: path, input })),
  ).arrayBuffer();
  const path = test.info().outputPath(name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, new Uint8Array(zip));
  return path;
}

/** The body content type of every publish/replace POST the page sends. */
function watchWrites(page: Page) {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (path === "/api/publish" || /^\/api\/anon\/[^/]+\/replace$/.test(path)) {
      writes.push(request.headers()["content-type"] ?? "");
    }
  });
  return writes;
}

/**
 * `url` off the dev edge until it answers 200 with `type` and `marker` — a
 * fresh slug's manifest can take a moment to reach the Worker's KV read.
 */
async function expectServed(url: string, type: string, marker: string) {
  await expect
    .poll(
      async () => {
        const probe = await probeEdge(url);
        return `${probe.status} ${probe.contentType.split(";")[0]} ${probe.body.includes(marker)}`;
      },
      { timeout: 60_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe(`200 ${type} true`);
}

interface Published {
  live_url: string;
  claim_url: string;
  anonToken: string;
}

async function landing(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
}

/** Drop `path` (a file or a folder) on the hero tile and wait for the 201. */
async function dropOnHero(page: Page, path: string): Promise<Published> {
  const published = page.waitForResponse(
    (res) => res.url().includes("/api/publish") && res.request().method() === "POST",
  );
  await (await holdPath(page, face(page, "idle"), path)).drop();
  const response = await published;
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as Published;
}

/** The tile resolved to `live` from the response: the minted host and the keep step. */
async function expectLive(page: Page, body: Published) {
  const host = new URL(body.live_url).host;
  expect(host.endsWith(`.${servingDomain()}`)).toBe(true);
  expect(body.claim_url).toContain(`/keep/${body.anonToken}`);
  await expect(face(page, "live")).toHaveCSS("opacity", "1");
  await expect(liveLabel(page)).toHaveText(host);
  await expect(page.getByRole("button", { name: /Keep it & manage it/ })).toBeVisible();
}

test.describe("landing + /p: folders and .zip files (E08 011)", () => {
  test.skip(!!SKIP_LIVE_PUBLISH, String(SKIP_LIVE_PUBLISH));
  test.describe.configure({ timeout: 180_000 });

  let drafts: Promise<string | null>[] = [];

  test.beforeEach(async ({ page }) => {
    drafts = trackDrafts(page);
  });

  test.afterEach(async ({ request }) => {
    await deleteDrafts(request, drafts);
  });

  test("a .zip dropped on the hero publishes as one multipart archive → live link + claim link; the edge serves index.html and the asset with their types", async ({
    page,
  }) => {
    const marker = `e08-011-zip-${run()}`;
    const files = siteFiles(marker);
    const zip = await writeZip(`${marker}.zip`, files);
    const writes = watchWrites(page);
    await landing(page);

    const body = await dropOnHero(page, zip);
    await expectLive(page, body);
    expect(writes).toHaveLength(1);
    expect(writes[0]!).toMatch(/^multipart\/form-data/);

    await expectServed(body.live_url, "text/html", marker);
    await expectServed(new URL("assets/site.css", body.live_url).href, "text/css", marker);
  });

  test("a folder dropped on the hero is walked, packed and published as one archive; /p then replaces it with another folder", async ({
    page,
  }) => {
    const marker = `e08-011-dir-${run()}`;
    const folder = await writeFolder(`${marker}/site`, siteFiles(marker));
    const writes = watchWrites(page);
    await landing(page);

    const body = await dropOnHero(page, folder);
    await expectLive(page, body);
    expect(writes[0]!).toMatch(/^multipart\/form-data/);
    await expectServed(new URL("assets/site.css", body.live_url).href, "text/css", marker);

    // ── /p: replace with a folder, through the "Browse folder" picker ───────
    await page.getByRole("button", { name: /manage this draft/ }).click();
    await expect(page).toHaveURL(/\/p\/[^/]+$/);
    // A full navigation: the Replace toggle only works once the screen hydrates.
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Replace" }).click();
    await expect(page.getByText("Drop an HTML file, a folder or a .zip, or browse")).toBeVisible();

    const next = `${marker}-v2`;
    const replacement = await writeFolder(`${next}/site`, siteFiles(next));
    const replaced = page.waitForResponse(
      (res) => /\/api\/anon\/[^/]+\/replace$/.test(res.url()) && res.request().method() === "POST",
    );
    await page.getByTestId("folder-input").setInputFiles(replacement);
    // Status only: the screen re-reads itself on success, which can discard the
    // response body before it is read here.
    expect((await replaced).status()).toBe(200);
    expect(writes.at(-1)!).toMatch(/^multipart\/form-data/);
    await expect(
      page.getByText("Replaced. The new version is live at the same link."),
    ).toBeVisible();
    await expectServed(new URL("assets/site.css", body.live_url).href, "text/css", next);
  });

  test("an anonymous .zip over the inline ceiling is refused before any request, with the server's sentence", async ({
    page,
  }) => {
    const writes = watchWrites(page);
    await landing(page);

    // Built in the page so the bytes never cross the wire: a "zip" one byte
    // over the inline ceiling. Its contents are never read — the size refuses it.
    await page.evaluate((limit) => {
      const input = document.querySelector('input[type="file"]')!;
      const big = new File([new Uint8Array(limit + 1)], "big.zip", {
        type: "application/zip",
      });
      const data = new DataTransfer();
      data.items.add(big);
      (input as HTMLInputElement).files = data.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, INLINE_BODY_MAX_BYTES);

    await expect(face(page, "error")).toHaveCSS("opacity", "1");
    await expect(face(page, "error")).toContainText(inlineTooLarge(INLINE_BODY_MAX_BYTES));
    expect(writes).toHaveLength(0);
  });
});
