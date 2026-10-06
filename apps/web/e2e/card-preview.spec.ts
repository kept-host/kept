import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { eq } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { ogTheme } from "../lib/og/palette";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import {
  cleanup,
  hydrated,
  newScope,
  publishOwned,
  signInAs,
  SKIP_OWNER_UI,
} from "./owner-fixtures";
import { gotoWithTokensApplied } from "./tokens-applied";

/**
 * The page's gradient, and the page itself on hover — E06 task 016.
 *
 * Arun: "the page preview images don't show up… replace it with some gradient
 * bg… yes live preview on hover can be good." Every card paints its page's
 * gradient under the OG PNG; resting a mouse on a live card shows the real page
 * over the thumbnail, in the sandboxed `srcdoc` frame every preview uses.
 *
 * The pages are published with a heading their own SCRIPT writes, so seeing
 * that text inside the frame proves the frame runs the page as it runs live —
 * and the frame's `window.origin` proves it does so in an opaque origin.
 *
 * Every read the preview makes is the real owner-only download route, watched
 * from the browser's own requests; a held request (`page.route` → leave →
 * release) shows that leaving the card aborts a read still in flight.
 *
 * NO MOCKS: a real magic-link session, real pages through `POST /api/sites`,
 * real bytes from R2. SKIPS without dev credentials, as every signed-in screen
 * spec does.
 */
const scope = newScope();

/** The heading text a page's own script writes — invisible to a frame without scripts. */
const scripted = (text: string): string =>
  `<span id="drawn"></span><script>document.getElementById("drawn").textContent = ${JSON.stringify(text)};</script>`;

const card = (page: Page, siteId: string): Locator =>
  page.locator(`[data-testid="home-card"][data-site-id="${siteId}"]`);

const thumbnail = (page: Page, siteId: string): Locator =>
  card(page, siteId).getByTestId("card-thumbnail");

const previewFrame = (page: Page, siteId: string): Locator =>
  card(page, siteId).locator('[data-testid="card-preview"] iframe');

/** Every page-HTML read the screen makes from now on, by site id. */
function watchReads(page: Page): string[] {
  const reads: string[] = [];
  page.on("request", (request) => {
    const read = /^\/api\/sites\/([^/]+)\/download$/.exec(new URL(request.url()).pathname);
    if (read) reads.push(read[1]!);
  });
  return reads;
}

/**
 * The thumbnail paints `ogTheme(siteId)` — compared as the browser computes
 * both, since a style the browser has parsed no longer reads as written.
 */
async function expectThemeOf(thumb: Locator, siteId: string): Promise<void> {
  const [painted, expected] = await thumb.evaluate((element, image) => {
    const probe = document.createElement("div");
    probe.style.backgroundImage = image;
    document.body.append(probe);
    const want = getComputedStyle(probe).backgroundImage;
    probe.remove();
    return [getComputedStyle(element).backgroundImage, want];
  }, ogTheme(siteId).image);
  expect(painted).toContain("gradient(");
  expect(painted).toBe(expected);
}

/**
 * The Pages home, styled and interactive. The styles matter here: the frame's
 * `pointer-events`, its fade and its opacity are all utility classes.
 */
async function openHome(page: Page, path = "/dashboard"): Promise<void> {
  await gotoWithTokensApplied(page, path);
  await hydrated(page);
}

/** Comfortably past the 350 ms hover delay plus a real read — for asserting an absence. */
const WELL_PAST_THE_DELAY_MS = 1_500;

/** Out of every card: the top-left corner is the studio's chrome. */
const leaveTheCards = (page: Page) => page.mouse.move(2, 2);

test.describe("card gradients and the hover preview", () => {
  test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
  test.describe.configure({ timeout: LIVE_STACK_TIMEOUT * 2 });

  test.beforeAll(async () => {
    if (SKIP_OWNER_UI) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_OWNER_UI) return;
    await cleanup(scope);
    await closeDb();
  });

  test("resting the mouse on a live card shows the page itself, sandboxed; leaving takes it away; a click still opens the page", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const marker = `drawn by script ${crypto.randomUUID().slice(0, 8)}`;
    const site = await publishOwned(page, baseURL!, scope, "E06 hover", scripted(marker));

    await openHome(page);
    const reads = watchReads(page);

    // The page's own gradient sits under the PNG — the same theme the OG card is drawn on.
    const thumb = thumbnail(page, site.siteId);
    await expectThemeOf(thumb, site.siteId);

    await thumb.hover();
    // Nothing is read, and nothing framed, before the pointer has rested.
    await expect(previewFrame(page, site.siteId)).toHaveCount(0);
    expect(reads, "no read before the hover delay").toEqual([]);

    const frame = previewFrame(page, site.siteId);
    await expect(frame).toHaveCount(1);
    // Exactly `allow-scripts`: never same-origin, navigation, popups or forms.
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(await frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(frame).toHaveAttribute("tabindex", "-1");
    await expect(frame).toHaveAttribute("aria-hidden", "true");
    await expect(frame).toHaveAttribute("srcdoc", /<script>/);
    await expect(frame).toHaveCSS("pointer-events", "none");
    // It fades in, over the design's 200 ms.
    await expect(frame).toHaveCSS("transition-duration", "0.2s");
    await expect(frame).toHaveCSS("opacity", "1");

    // The page, as it runs: its script wrote this — in an origin of its own.
    const inside = frame.contentFrame();
    await expect(inside.getByText(marker)).toBeVisible();
    expect(await inside.locator("body").evaluate(() => window.origin)).toBe("null");
    expect(reads, "one read, through the owner's download route").toEqual([site.siteId]);

    await leaveTheCards(page);
    await expect(previewFrame(page, site.siteId)).toHaveCount(0);

    // Back again: the session already holds this version's HTML.
    await thumb.hover();
    await expect(previewFrame(page, site.siteId).contentFrame().getByText(marker)).toBeVisible();
    expect(reads, "the second look reads nothing").toEqual([site.siteId]);

    // The frame lets every click through to the thumbnail's link.
    await thumb.click();
    await expect(page).toHaveURL(new RegExp(`/site/${site.siteId}$`));
  });

  test("a renamed page keeps its gradient while its card URL moves", async ({ page, baseURL }) => {
    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 hover rename");

    await openHome(page);
    const before = await thumbnail(page, site.siteId).locator("img").getAttribute("src");
    expect(before).toMatch(/\?v=\d+-t2$/);
    await expectThemeOf(thumbnail(page, site.siteId), site.siteId);

    // The theme is the id's, not the name's: a rename moves the card URL
    // (`updated_at`) and the name on it, and nothing else.
    const name = `e06-hover-${crypto.randomUUID().slice(0, 8)}`;
    const renamed = await page.request.patch(`${baseURL}/api/sites/${site.siteId}/name`, {
      headers: { origin: new URL(baseURL!).origin },
      data: { name },
    });
    expect(renamed.status(), await renamed.text()).toBe(200);
    scope.slugs.add(name);

    await openHome(page);
    await expect(card(page, site.siteId)).toContainText(name);
    const after = await thumbnail(page, site.siteId).locator("img").getAttribute("src");
    expect(after).toMatch(/\?v=\d+-t2$/);
    expect(after).not.toBe(before);
    await expectThemeOf(thumbnail(page, site.siteId), site.siteId);
  });

  test("leaving the card aborts a read still in flight, and nothing is framed", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 hover abort");

    await openHome(page);

    // The real read, held at the browser until the pointer has gone.
    let held: Route | null = null;
    await page.route(`**/api/sites/${site.siteId}/download`, (route) => {
      held = route;
    });
    const aborted = page.waitForEvent(
      "requestfailed",
      (request) => new URL(request.url()).pathname === `/api/sites/${site.siteId}/download`,
    );

    await thumbnail(page, site.siteId).hover();
    await expect.poll(() => held !== null, { message: "the read left after the delay" }).toBe(true);
    await leaveTheCards(page);

    const failed = await aborted;
    expect(failed.failure()?.errorText).toContain("ERR_ABORTED");
    await (held as Route | null)?.continue().catch(() => {});
    await page.waitForTimeout(WELL_PAST_THE_DELAY_MS);
    await expect(previewFrame(page, site.siteId)).toHaveCount(0);
  });

  test("a live draft previews too; a list row never does", async ({ page, baseURL }) => {
    await signInAs(page, baseURL!, scope);
    const kept = await publishOwned(page, baseURL!, scope, "E06 hover kept", scripted("kept page body"));
    const draft = await publishOwned(page, baseURL!, scope, "E06 hover draft", scripted("draft page body"));
    const demoted = await page.request.post(`${baseURL}/api/sites/${draft.siteId}/demote`, {
      headers: { origin: new URL(baseURL!).origin },
    });
    expect(demoted.status(), await demoted.text()).toBe(200);

    await openHome(page);
    await expect(page.getByTestId("drafts-strip")).toContainText(draft.name);
    await thumbnail(page, draft.siteId).hover();
    await expect(previewFrame(page, draft.siteId).contentFrame().getByText("draft page body")).toBeVisible();
    await leaveTheCards(page);
    await expect(previewFrame(page, draft.siteId)).toHaveCount(0);

    await openHome(page, "/dashboard?view=list");
    await expect(page.getByTestId("kept-wall")).toHaveAttribute("data-view", "list");
    const reads = watchReads(page);
    await thumbnail(page, kept.siteId).hover();
    await page.waitForTimeout(WELL_PAST_THE_DELAY_MS);
    await expect(card(page, kept.siteId).getByTestId("card-preview")).toHaveCount(0);
    expect(reads, "a list row reads nothing").toEqual([]);
  });

  test("a page that is not live never previews, and keeps its gradient", async ({ page, baseURL }) => {
    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 hover flagged");
    // Flagged by hand — E07 owns the real flip; E06 only renders it.
    await db.update(schema.sites).set({ status: "under_review" }).where(eq(schema.sites.id, site.siteId));
    try {
      await openHome(page);
      const reads = watchReads(page);
      const thumb = thumbnail(page, site.siteId);
      await expect(card(page, site.siteId).getByText("Under review")).toBeVisible();
      await expectThemeOf(thumb, site.siteId);

      await thumb.hover();
      await page.waitForTimeout(WELL_PAST_THE_DELAY_MS);
      await expect(card(page, site.siteId).getByTestId("card-preview")).toHaveCount(0);
      expect(reads, "a page that is not live is never read").toEqual([]);
    } finally {
      await db.update(schema.sites).set({ status: "live" }).where(eq(schema.sites.id, site.siteId));
    }
  });

  test("under reduced motion the preview still shows, without the fade", async ({ page, baseURL }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 hover reduced", scripted("still here"));

    await openHome(page);
    await thumbnail(page, site.siteId).hover();
    const frame = previewFrame(page, site.siteId);
    await expect(frame.contentFrame().getByText("still here")).toBeVisible();
    await expect(frame).toHaveCSS("transition-duration", "0s");
    await expect(frame).toHaveCSS("opacity", "1");
  });

  test.describe("on a touch screen", () => {
    test.use({ hasTouch: true });

    test("there is no hover, so there is no preview — a tap opens the page", async ({ page, baseURL }) => {
      await signInAs(page, baseURL!, scope);
      const site = await publishOwned(page, baseURL!, scope, "E06 hover touch");

      await openHome(page);
      expect(
        await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches),
        "the context really is a touch screen",
      ).toBe(false);
      const reads = watchReads(page);

      await thumbnail(page, site.siteId).hover();
      await page.waitForTimeout(WELL_PAST_THE_DELAY_MS);
      await expect(card(page, site.siteId).getByTestId("card-preview")).toHaveCount(0);

      await thumbnail(page, site.siteId).tap();
      await expect(page).toHaveURL(new RegExp(`/site/${site.siteId}$`));
      expect(reads, "a touch screen never reads a page for a preview").toEqual([]);
    });
  });
});
