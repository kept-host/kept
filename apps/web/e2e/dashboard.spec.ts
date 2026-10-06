import { DRAFT_GRACE_DAYS, demoteResultSchema, limitsFor } from "@kept/shared";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { and, eq } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import {
  ALREADY_PUBLISHED_NOTICE,
  KEPT_TOAST,
  PUBLISHED_KEPT_TOAST,
  REPLACED_TOAST,
  UNDONE_TOAST,
  atLimitBanner,
  atLimitPublishToast,
  noSearchResults,
} from "../lib/sites/display";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import {
  cleanup,
  drop,
  hold,
  hydrated,
  newScope,
  publishOwned,
  readSite,
  seedKept,
  seedVisits,
  signInAs,
  titledHtml,
  SKIP_OWNER_UI,
} from "./owner-fixtures";
import { waitForTokensApplied } from "./tokens-applied";

/**
 * The Pages home `/dashboard` in a real browser, against the REAL dev stack —
 * E06 task 011 (PRD §5.1, §9.1): AC2 (UI), AC4–AC9, AC10, AC11 (UI), and the
 * card drop → replace.
 *
 * NO MOCKS. Pages an assertion is about are published through `POST /api/sites`
 * by a real magic-link session; rows that only FILL an account (to its kept
 * limit, or to give a list something to sort) are real rows inserted straight
 * into Postgres (`seedKept`, `seedDraft`) — the screens and the cap count them
 * like any page. Visits are real `page_views_daily` rows.
 *
 * Drops are real files dragged through Chromium's own input pipeline onto the
 * element a user would drop on (`hold` / `drop` in `owner-fixtures.ts`); the
 * window-level target and the card targets receive them exactly as they would a
 * drag from the desktop.
 *
 * SKIPS without dev credentials: CI runs fork PRs with no secrets.
 */
const scope = newScope();
const FREE = limitsFor("free");
const PRO = limitsFor("premium");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const PNG_REFUSAL = "That's a .png. kept publishes HTML pages — drop an .html file.";

/** Text a later epic owns. None of it may exist anywhere in the home's DOM (AC10). */
const LATER_EPIC_TEXT: readonly RegExp[] = [
  /\bWall\b/,
  /\bExplore\b/,
  /\bReferrals\b/,
  /\bAgents?\b/,
  /\bProfile\b/,
  /\bBadge\b/,
  /\bPassword\b/,
  /Share kit/i,
  /Getting started/i,
  /Copy (the )?prompt/i,
  /Claim your handle/i,
  /Ask your agent/i,
  /MCP/,
  /Make room/i,
  /Apply for Founding/i,
  /\bSoon\b/,
];

test.describe("the Pages home", () => {
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

  /** Demote through the real route, so the fixture and the product agree. */
  async function demote(page: Page, baseURL: string, siteId: string) {
    const response = await page.request.post(`${baseURL}/api/sites/${siteId}/demote`, {
      headers: { origin: new URL(baseURL).origin },
    });
    expect(response.status(), await response.text()).toBe(200);
    return demoteResultSchema.parse(await response.json());
  }

  /** An owned draft row, straight into Postgres — for clocks and ordering. */
  async function seedDraft(
    ownerId: string,
    expiresAt: Date,
    extra: Partial<typeof schema.sites.$inferInsert> = {},
  ): Promise<{ siteId: string; slug: string }> {
    const id = crypto.randomUUID();
    const slug = `e06-draft-${id.slice(0, 8)}${id.slice(9, 13)}`;
    await db.insert(schema.sites).values({
      id,
      slug,
      ownerId,
      publisherHash: "e06-e2e-seed",
      claimedAt: new Date(),
      contentHash: "e06-e2e-seed",
      sizeBytes: 128,
      expiresAt,
      purgeAfter: new Date(expiresAt.getTime() + DRAFT_GRACE_DAYS * DAY),
      ...extra,
    });
    scope.siteIds.push(id);
    return { siteId: id, slug };
  }

  const card = (page: Page, siteId: string) =>
    page.locator(`[data-testid="home-card"][data-site-id="${siteId}"]`);

  const summaryItem = (page: Page, label: string) =>
    page.getByRole("list", { name: "Summary" }).getByRole("listitem").filter({ hasText: label });

  /** The order the cards appear in, by site id. */
  const order = (list: Locator) =>
    list.locator('[data-testid="home-card"]').evaluateAll((items) =>
      items.map((item) => item.getAttribute("data-site-id")),
    );

  /** Every text node in the document except scripts and styles — hidden ones included. */
  const domText = (page: Page) =>
    page.evaluate(() => {
      const body = document.body.cloneNode(true) as HTMLElement;
      body.querySelectorAll("script, style, noscript").forEach((node) => node.remove());
      return body.textContent ?? "";
    });

  test("AC10: the shell has exactly Pages and Settings, a plan badge and an avatar menu — and no later epic", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    await publishOwned(page, baseURL!, scope, "E06 shell page");
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 1, name: "Your pages" })).toBeVisible();

    // Both presentations of the nav — the sidebar and the phone's tab bar —
    // carry exactly two links, in the DOM, whichever one is on screen.
    for (const nav of await page.locator('nav[aria-label="Studio"]').all()) {
      const links = await nav
        .locator("a")
        .evaluateAll((anchors) =>
          anchors.map((a) => [a.textContent?.trim(), a.getAttribute("href")]),
        );
      expect(links).toEqual([
        ["Pages", "/dashboard"],
        ["Settings", "/settings"],
      ]);
    }
    await expect(page.locator('nav[aria-label="Studio"]')).toHaveCount(2);

    await expect(page.getByTestId("plan-badge").first()).toHaveText("Free");

    await page.getByTestId("account-menu-sidebar").click();
    await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
    await page.keyboard.press("Escape");

    // No later epic's element exists anywhere — on the home, nor in the open
    // publish sheet (whose agent and MCP blocks are E08/E09's).
    for (const pattern of LATER_EPIC_TEXT) expect(await domText(page)).not.toMatch(pattern);
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByTestId("publish-sheet")).toBeVisible();
    for (const pattern of LATER_EPIC_TEXT) expect(await domText(page)).not.toMatch(pattern);
  });

  test("AC4: an account with no pages sees the mascot, the line and a large drop zone — and no counters", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    await page.goto("/dashboard");

    const empty = page.getByTestId("empty-state");
    await expect(empty.getByRole("heading", { name: "Nothing kept yet. Drop a file to begin." })).toBeVisible();
    await expect(empty.locator("svg[data-mascot]")).toHaveAttribute("aria-hidden", "true");
    await expect(empty.getByRole("button", { name: /Drop an \.html file/ })).toBeVisible();
    await expect(page.getByRole("list", { name: "Summary" })).toHaveCount(0);
    await expect(page.getByTestId("home-card")).toHaveCount(0);

    // Phone width: same state, no horizontal scroll.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(empty).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

  test("AC5 + AC6 + AC9: counters, drafts by soonest expiry with the 48-hour chip, search, sort and ?view=list", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    const alpha = await publishOwned(page, baseURL!, scope, "Alpha Tide");
    const beta = await publishOwned(page, baseURL!, scope, "Beta Orbit");
    const seeded = await seedKept(scope, userId, 2);
    const later = await seedDraft(userId, new Date(Date.now() + 5 * DAY));
    const urgent = await seedDraft(userId, new Date(Date.now() + 20 * HOUR));
    const middle = await seedDraft(userId, new Date(Date.now() + 3 * DAY));
    await seedVisits(alpha.siteId, 5);
    await seedVisits(beta.siteId, 40);

    await page.goto("/dashboard");

    // AC5 — the counters, limits from limitsFor("free"), and the drafts strip.
    await expect(summaryItem(page, "Kept")).toContainText(`4 / ${FREE.keptPages}`);
    await expect(summaryItem(page, "Names")).toContainText(`0 / ${FREE.chosenNames}`);
    await expect(summaryItem(page, "Drafts")).toContainText("3");

    const strip = page.getByTestId("drafts-strip");
    const wall = page.getByTestId("kept-wall");
    await expect.poll(() => order(strip)).toEqual([urgent.siteId, middle.siteId, later.siteId]);

    // AC9 — the last-48-hours chip is `--warning`; the others are not.
    // The chip is the `<time>`'s parent.
    const chip = (siteId: string, label: RegExp) =>
      card(page, siteId).getByText(label).locator("xpath=..");
    await expect(chip(urgent.siteId, /^Draft · \d+ hours left$/)).toHaveClass(/--warning/);
    await expect(chip(middle.siteId, /^Draft · \d+ days left$/)).not.toHaveClass(/--warning/);

    // AC6 — search over title and name, client-side.
    const search = page.getByRole("searchbox", { name: "Search your pages" });
    await search.fill("beta orbit");
    await expect.poll(() => order(wall)).toEqual([beta.siteId]);
    await expect(strip).toHaveCount(0);
    await search.fill(seeded[1]!.slug);
    await expect.poll(() => order(wall)).toEqual([seeded[1]!.siteId]);

    // No results, and the way back.
    await search.fill("zzz-nothing-here");
    await expect(page.getByText(noSearchResults("zzz-nothing-here"))).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(search).toHaveValue("");
    await expect.poll(async () => (await order(wall)).length).toBe(4);

    // Most visited: the 7-day sum, descending — and pages with no data LAST.
    await page.getByRole("button", { name: "Most visited" }).click();
    await expect.poll(async () => (await order(wall))[0]).toBe(beta.siteId);
    const byVisits = await order(wall);
    expect(byVisits.slice(0, 2)).toEqual([beta.siteId, alpha.siteId]);
    expect(byVisits.slice(2).sort()).toEqual(seeded.map((row) => row.siteId).sort());
    await expect(card(page, beta.siteId)).toContainText("40 visits");

    // Name: A → Z by what the card calls the page.
    await page.getByRole("button", { name: "Name", exact: true }).click();
    await expect.poll(async () => (await order(wall))[0]).toBe(alpha.siteId);

    // ?view=list renders list rows and survives a reload.
    await page.getByRole("button", { name: "List" }).click();
    await expect(wall).toHaveAttribute("data-view", "list");
    await expect(page).toHaveURL(/[?&]view=list\b/);
    await page.reload();
    await expect(page.getByTestId("kept-wall")).toHaveAttribute("data-view", "list");
    await expect(page.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");

    // Phone width: no horizontal page scroll (the strip scrolls inside itself).
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("kept-wall")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

  test("AC9: a draft past expires_at flips to expired on the next tick, without a reload; expired-in-grace says how long is left", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    const expiring = await seedDraft(userId, new Date(Date.now() + 20_000));
    const inGrace = await seedDraft(userId, new Date(Date.now() - 2 * DAY - HOUR), {
      status: "expired",
      purgeAfter: new Date(Date.now() + 10 * DAY + HOUR),
    });

    // The browser's clock, under the test's control — the ROW is real and
    // untouched; only the minute tick is advanced instead of waited for.
    await page.clock.install();
    await page.goto("/dashboard");

    const flipping = card(page, expiring.siteId);
    await expect(flipping.getByText("Draft · under an hour left")).toBeVisible();
    await page.clock.fastForward("01:00");
    await expect(flipping.getByText("Draft · expired")).toBeVisible();
    await expect(flipping.getByText(/^Expired today — keep within \d+ days$/)).toBeVisible();
    expect((await readSite(expiring.siteId)).status, "E07 flips the row, not this screen").toBe("live");

    // Expired inside its grace: muted, with the PRD's sentence and a Keep.
    const grace = card(page, inGrace.siteId);
    await expect(grace.getByText("Expired 2 days ago — keep within 11 days")).toBeVisible();
    await expect(grace.getByTestId("keep-button")).toHaveText(/^Keep/);
  });

  test("AC7 + AC8: a dropped HTML file publishes, a .png is refused without a request, and the same bytes twice make one page", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    await publishOwned(page, baseURL!, scope, "E06 drop neighbour");
    await page.goto("/dashboard");
    await hydrated(page);

    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/sites") {
        posts.push(request.url());
      }
    });

    // A .png anywhere on the home: the PRD's sentence, and nothing sent.
    const anywhere = page.getByRole("heading", { level: 1, name: "Your pages" });
    await drop(page, anywhere, { name: "shot.png", body: "\u0089PNG" });
    await expect(page.getByTestId("publish-error")).toHaveText(PNG_REFUSAL);
    expect(posts, "a refused file never becomes a request").toEqual([]);

    // An HTML file anywhere on the home: published, kept, toasted, highlighted.
    const title = `E06 dropped ${crypto.randomUUID().slice(0, 8)}`;
    const html = titledHtml(title);
    await drop(page, anywhere, { name: "dropped.html", body: html });
    await expect(page.getByText(PUBLISHED_KEPT_TOAST)).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    expect(posts).toHaveLength(1);

    const rows = () =>
      db
        .select({ id: schema.sites.id, slug: schema.sites.slug, expiresAt: schema.sites.expiresAt })
        .from(schema.sites)
        .where(and(eq(schema.sites.ownerId, userId), eq(schema.sites.title, title)));
    const [row] = await rows();
    expect(row, "the drop created the page").toBeDefined();
    scope.siteIds.push(row!.id);
    scope.slugs.add(row!.slug);
    expect(row!.expiresAt, "under the limit it lands kept").toBeNull();
    // The card arrives after the mint card's hop and the refresh (task 015).
    await expect(card(page, row!.id)).toHaveAttribute("data-highlighted", "true", {
      timeout: LIVE_STACK_TIMEOUT,
    });

    // AC8 — the same bytes again: no new page, the toast, the card highlighted.
    await expect(card(page, row!.id)).not.toHaveAttribute("data-highlighted", "true", { timeout: 10_000 });
    await drop(page, anywhere, { name: "dropped-again.html", body: html });
    await expect(page.getByText(ALREADY_PUBLISHED_NOTICE)).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    await expect(card(page, row!.id)).toHaveAttribute("data-highlighted", "true", {
      timeout: LIVE_STACK_TIMEOUT,
    });
    await expect(card(page, row!.id)).toHaveAttribute("data-arrival", "duplicate");
    expect(await rows(), "publishing identical bytes twice creates one page").toHaveLength(1);

    // Paste (design ↔ PRD call 9): the sheet posts { html } to the same route.
    const pasted = `E06 pasted ${crypto.randomUUID().slice(0, 8)}`;
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    const sheet = page.getByTestId("publish-sheet");
    await sheet.getByRole("button", { name: "Or paste HTML" }).click();
    await sheet.getByRole("textbox", { name: "Paste HTML" }).fill(titledHtml(pasted));
    await sheet.getByRole("button", { name: "Publish pasted HTML" }).click();
    // The sheet closes as the request leaves (task 015); the page lands after.
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId("mint-card")).toHaveCount(0, { timeout: LIVE_STACK_TIMEOUT });
    const [pastedRow] = await db
      .select({ id: schema.sites.id, slug: schema.sites.slug })
      .from(schema.sites)
      .where(and(eq(schema.sites.ownerId, userId), eq(schema.sites.title, pasted)));
    expect(pastedRow, "the paste created the page").toBeDefined();
    scope.siteIds.push(pastedRow!.id);
    scope.slugs.add(pastedRow!.slug);
    await expect(card(page, pastedRow!.id)).toBeVisible();
  });

  test("AC2 (UI): at the kept limit — KEPT turns warning, the banner dismisses for the session, and a publish lands as a draft", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    await seedKept(scope, userId, FREE.keptPages - 1);
    const last = await publishOwned(page, baseURL!, scope, "E06 last slot");
    expect(last.outcome).toBe("kept");

    await page.goto("/dashboard");
    await hydrated(page);

    await expect(summaryItem(page, "Kept")).toContainText(`${FREE.keptPages} / ${FREE.keptPages}`);
    await expect(summaryItem(page, "Kept")).toHaveClass(/text-warning/);

    const banner = page.getByTestId("limit-banner");
    await expect(banner).toContainText(atLimitBanner(FREE.keptPages));
    await expect(banner).toContainText(`Keep ${PRO.keptPages.toLocaleString("en-US")} pages with Pro`);
    await banner.getByRole("button", { name: "Dismiss" }).click();
    await expect(banner).toHaveCount(0);

    const title = `E06 at limit ${crypto.randomUUID().slice(0, 8)}`;
    await drop(page, page.getByRole("heading", { level: 1, name: "Your pages" }), {
      name: "at-limit.html",
      body: titledHtml(title),
    });
    await expect(page.getByText(atLimitPublishToast(FREE.keptPages))).toBeVisible({
      timeout: LIVE_STACK_TIMEOUT,
    });

    const [row] = await db
      .select({ id: schema.sites.id, slug: schema.sites.slug, expiresAt: schema.sites.expiresAt })
      .from(schema.sites)
      .where(and(eq(schema.sites.ownerId, userId), eq(schema.sites.title, title)));
    expect(row).toBeDefined();
    scope.siteIds.push(row!.id);
    scope.slugs.add(row!.slug);
    expect(row!.expiresAt, "at the limit the page lands as a draft, never an error").not.toBeNull();

    // The new draft is in the strip, and at the limit its action is Swap….
    const draftCard = page.getByTestId("drafts-strip").locator(`[data-site-id="${row!.id}"]`);
    await expect(draftCard.getByTestId("keep-button")).toHaveText(/^Swap…/);
    // The dismissal outlived the refresh that brought the new card in.
    await expect(page.getByTestId("limit-banner")).toHaveCount(0);
  });

  test("Pro: the counters read the premium limits", async ({ page, baseURL }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    await db.update(schema.profiles).set({ plan: "premium" }).where(eq(schema.profiles.id, userId));
    await publishOwned(page, baseURL!, scope, "E06 pro page");
    await page.goto("/dashboard");

    await expect(summaryItem(page, "Kept")).toContainText(`1 / ${PRO.keptPages}`);
    await expect(summaryItem(page, "Names")).toContainText(`0 / ${PRO.chosenNames}`);
    await expect(page.getByTestId("plan-badge").first()).toHaveText("Pro");
    await expect(page.getByText(/with Pro/)).toHaveCount(0);
  });

  test("AC11 (UI): Keep below the limit, late keep in grace, and a 409 at_kept_limit race switches the card to Swap…", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    const draft = await publishOwned(page, baseURL!, scope, "E06 keep me");
    await demote(page, baseURL!, draft.siteId);
    const late = await publishOwned(page, baseURL!, scope, "E06 keep me late");
    await demote(page, baseURL!, late.siteId);
    await db
      .update(schema.sites)
      .set({
        status: "expired",
        expiresAt: new Date(Date.now() - DAY - HOUR),
        purgeAfter: new Date(Date.now() + 20 * DAY),
      })
      .where(eq(schema.sites.id, late.siteId));

    await page.goto("/dashboard");
    await hydrated(page);
    const wall = page.getByTestId("kept-wall");

    // Below the limit: Keep → the toast → the card moves to the wall.
    await card(page, draft.siteId).getByTestId("keep-button").click();
    await expect(page.getByText(KEPT_TOAST).first()).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    await expect(wall.locator(`[data-site-id="${draft.siteId}"]`)).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    expect((await readSite(draft.siteId)).expiresAt).toBeNull();

    // Late keep: an expired draft inside its grace is restored and kept.
    await card(page, late.siteId).getByTestId("keep-button").click();
    await expect(wall.locator(`[data-site-id="${late.siteId}"]`)).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    const restored = await readSite(late.siteId);
    expect(restored.status).toBe("live");
    expect(restored.expiresAt).toBeNull();

    // The race: one slot left when the screen renders, filled in another tab
    // before the click. The server answers 409 at_kept_limit; the card turns
    // into Swap… and the chooser opens.
    const racer = await publishOwned(page, baseURL!, scope, "E06 racer");
    await demote(page, baseURL!, racer.siteId);
    await seedKept(scope, userId, FREE.keptPages - 3);
    await page.goto("/dashboard");
    await hydrated(page);
    const racerButton = card(page, racer.siteId).getByTestId("keep-button");
    await expect(racerButton).toHaveText(/^Keep/);
    await seedKept(scope, userId, 1);
    await racerButton.click();
    await expect(page.getByTestId("swap-dialog")).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    await page.getByTestId("swap-cancel").click();
    await expect(racerButton).toHaveText(/^Swap…/);
    expect((await readSite(racer.siteId)).expiresAt, "nothing was written").not.toBeNull();

    // And on a fresh render at the limit, the action simply reads Swap….
    await page.reload();
    await expect(card(page, racer.siteId).getByTestId("keep-button")).toHaveText(/^Swap…/);
  });

  test("card drop: identical bytes are a no-op, new bytes replace with Undo, and an under-review card takes no drop", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    const target = await publishOwned(page, baseURL!, scope, "E06 replace me");
    const [flagged] = await seedKept(scope, userId, 1);
    await db
      .update(schema.sites)
      .set({ status: "under_review" })
      .where(eq(schema.sites.id, flagged!.siteId));
    const original = (await readSite(target.siteId)).currentVersionId;

    await page.goto("/dashboard");
    await hydrated(page);
    const article = card(page, target.siteId).locator("article");

    await drop(page, article, { name: "same.html", body: target.html });
    await expect(page.getByText("No changes — that's already the live version.")).toBeVisible({
      timeout: LIVE_STACK_TIMEOUT,
    });
    expect((await readSite(target.siteId)).currentVersionId).toBe(original);

    await drop(page, article, {
      name: "new.html",
      body: titledHtml(`E06 replaced ${crypto.randomUUID().slice(0, 8)}`),
    });
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: REPLACED_TOAST });
    await expect(toast).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    const replaced = (await readSite(target.siteId)).currentVersionId;
    expect(replaced).not.toBe(original);

    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText(UNDONE_TOAST)).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    expect((await readSite(target.siteId)).currentVersionId, "Undo restores the previous version").toBe(
      original,
    );

    // Edge case 10: a page under review cannot be replaced, so it is no drop
    // target — a file held over it gets the window's "Drop to publish" — and it
    // offers no Replace file.
    const reviewed = card(page, flagged!.siteId);
    const held = await hold(page, reviewed.locator("article"), {
      name: "held.html",
      body: titledHtml("E06 held over a reviewed page"),
    });
    await expect(page.getByTestId("drop-overlay-window")).toBeVisible();
    await expect(reviewed.getByText("Drop to replace this page")).toHaveCount(0);
    await held.cancel();
    await expect(reviewed.getByRole("button", { name: /Replace file/ })).toHaveCount(0);
  });

  test("the screen paints from tokens, so it is correct in dark too", async ({ page, baseURL }) => {
    await signInAs(page, baseURL!, scope);
    await publishOwned(page, baseURL!, scope, "E06 dark");
    await page.goto("/dashboard");
    await waitForTokensApplied(page);

    const surface = page.locator('[data-testid="home-card"] article').first();
    const readColours = () =>
      surface.evaluate((node) => {
        const style = getComputedStyle(node);
        return { bg: style.backgroundColor, fg: style.color };
      });
    const light = await readColours();

    // Imperatively, as `auth-screen` and `smoke` do: v1 pins light and has no
    // toggle, so stamping the attribute is the only way to prove the dark token
    // block still resolves on this screen. Not a claim that dark ships.
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    const dark = await readColours();
    expect(dark.bg, "a card painted from tokens repaints in dark").not.toBe(light.bg);
    expect(dark.fg, "and so does its text").not.toBe(light.fg);
  });
});
