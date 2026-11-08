import { MANIFEST_KV_CACHE_TTL_SECONDS, README_PAGE_PATH } from "@kept/shared";
import { expect, test, type Page } from "@playwright/test";

import { closeDb } from "../lib/db";
import { pointerKey } from "../lib/storage/manifest";
import { r2Store, readmeObjectKey } from "../lib/storage/r2";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { cleanup, newScope, publishOwned, readSite, signInAs, SKIP_OWNER_UI, type OwnedPage } from "./owner-fixtures";

/**
 * The Details panel's provenance and the README page — E10 task 006 (AC10,
 * PRD §5.3, §8 Details states).
 *
 * NO MOCKS. One owned page is published for real (it lands kept) and reused by
 * every test, in order: the owner fills model, tool and a README holding a
 * `<script>` through the real panel; the control plane's half is read straight
 * from the stores — the README object in R2 and the slug pointer (byte-identical
 * to KV) — and the edge's half from the deployed Worker.
 *
 * `@edge` tests need E10's Worker (task 004) on dev: until the rc tag deploys
 * the branch (Q25) they cannot pass, so the pre-gate run is
 * `--grep-invert @edge`. Each edge check after a manifest change polls until
 * the second purge has landed — `(2 * MANIFEST_KV_CACHE_TTL_SECONDS + 15) * 1000`
 * ms — because the first purge cannot reach the Worker's KV read cache.
 *
 * KV BUDGET (≤ 6): the publish, the README save, the clear — three writes — and
 * one delete in teardown.
 */
const EDGE_WAIT_MS = (2 * MANIFEST_KV_CACHE_TTL_SECONDS + 15) * 1000;
const POLL_MS = 3_000;

/** Markdown with raw HTML in it — AC10 says it comes out as text. */
const README = "## How I made it\n\nOne prompt, then <script>alert('readme')</script> by hand.";

const scope = newScope();

interface ReadmeProbe {
  status: number;
  csp: string;
  body: string;
}

/** Poll `/_kept/readme` until `done` or the second purge's deadline. No query string: it would defeat the purge. */
async function waitForReadme(url: string, done: (probe: ReadmeProbe) => boolean): Promise<ReadmeProbe> {
  const deadline = Date.now() + EDGE_WAIT_MS;
  for (;;) {
    const res = await fetch(url, { redirect: "manual" });
    const probe = { status: res.status, csp: res.headers.get("content-security-policy") ?? "", body: await res.text() };
    if (done(probe) || Date.now() > deadline) return probe;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** The detail screen, hydrated: a tab switch only works once React owns the page. */
async function openDetail(page: Page, siteId: string) {
  await page.goto(`/site/${siteId}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("tab", { name: "Versions" }).click();
  await expect(page.getByTestId("versions-panel")).toBeVisible();
  await page.getByRole("tab", { name: "General" }).click();
}

async function pointerBadge(slug: string): Promise<Record<string, unknown>> {
  const body = await r2Store().get(pointerKey(slug));
  expect(body, `the manifest for ${slug} must exist`).not.toBeNull();
  return (JSON.parse(body!) as { badge: Record<string, unknown> }).badge;
}

test.describe("Details: provenance and the README page", () => {
  test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
  test.describe.configure({ mode: "serial", timeout: LIVE_STACK_TIMEOUT + EDGE_WAIT_MS });

  let site: OwnedPage;
  let readmeUrl = "";
  let email = "";

  test.beforeAll(async () => {
    if (SKIP_OWNER_UI) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_OWNER_UI) return;
    await cleanup(scope);
    await closeDb();
  });

  test("saving provenance and a README writes the README page and puts it in the badge", async ({ page, baseURL }) => {
    ({ email } = await signInAs(page, baseURL!, scope));
    site = await publishOwned(page, baseURL!, scope, "E10 readme");
    expect(site.outcome).toBe("kept");
    readmeUrl = `${site.liveUrl}/${README_PAGE_PATH}`;

    await openDetail(page, site.siteId);
    const panel = page.getByTestId("details-section");
    await panel.getByTestId("model-input").fill("claude-opus-4-7");
    await panel.getByTestId("tool-input").fill("Claude Code");
    await panel.getByTestId("readme-input").fill(README);
    await expect(panel.getByTestId("readme-count")).toHaveText(`${README.length} / 20,000`);
    await expect(panel.getByTestId("save-bar")).toHaveAttribute("data-phase", "dirty");

    // Preview: the README page's own renderer, raw HTML as text.
    await panel.getByTestId("readme-preview-tab").click();
    const preview = panel.getByTestId("readme-preview");
    await expect(preview.locator("h2")).toHaveText("How I made it");
    await expect(preview).toContainText("<script>alert('readme')</script>");
    await expect(preview.locator("script")).toHaveCount(0);

    await panel.getByTestId("details-save").click();
    await expect(panel.getByTestId("save-bar")).toContainText("Saved. Showing on your page in about 2 minutes.");

    const row = await readSite(site.siteId);
    expect(row.model).toBe("claude-opus-4-7");
    expect(row.tool).toBe("Claude Code");
    expect(row.readme).toBe(README);

    const object = await r2Store().get(readmeObjectKey(site.siteId));
    expect(object, "the README page is in R2").not.toBeNull();
    expect(object).toContain(`<title>How ${site.title} was made</title>`);
    expect(object).toContain("&lt;script&gt;alert('readme')&lt;/script&gt;");
    expect(object).not.toMatch(/<script/i);
    expect(object).toContain("Made with claude-opus-4-7");

    const badge = await pointerBadge(site.slug);
    expect(badge.readme).toBe(true);
    expect(badge.model).toBe("claude-opus-4-7");
  });

  test("@edge /_kept/readme serves it with the kept-own CSP, the script as text", async () => {
    const served = await waitForReadme(readmeUrl, (probe) => probe.status === 200);
    expect(served.status).toBe(200);
    expect(served.csp).toContain("default-src 'none'");
    expect(served.body).toContain("&lt;script&gt;");
    expect(served.body).not.toMatch(/<script/i);
  });

  test("a bad source link is a field error, and nothing is sent", async ({ page, baseURL }) => {
    await signInAs(page, baseURL!, scope, email);
    await openDetail(page, site.siteId);
    const panel = page.getByTestId("details-section");
    await panel.getByTestId("source-url-input").fill("ftp://example.com/src");
    await panel.getByTestId("details-save").click();
    await expect(panel.getByRole("alert").first()).toContainText("starts with https://");
    await expect(panel.getByTestId("save-bar")).toHaveAttribute("data-phase", "error");
    expect((await readSite(site.siteId)).sourceUrl).toBeNull();
  });

  test("clearing the README deletes the object and drops it from the badge", async ({ page, baseURL }) => {
    await signInAs(page, baseURL!, scope, email);
    await openDetail(page, site.siteId);
    const panel = page.getByTestId("details-section");
    await panel.getByTestId("readme-input").fill("");
    await panel.getByTestId("details-save").click();
    await expect(panel.getByTestId("save-bar")).toContainText("Saved. Showing on your page in about 2 minutes.");

    expect((await readSite(site.siteId)).readme).toBeNull();
    expect(await r2Store().get(readmeObjectKey(site.siteId))).toBeNull();
    expect((await pointerBadge(site.slug)).readme).toBeUndefined();
  });

  test("@edge /_kept/readme is a 404 once the README is cleared", async () => {
    const gone = await waitForReadme(readmeUrl, (probe) => probe.status === 404);
    expect(gone.status).toBe(404);
  });
});
