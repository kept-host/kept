import { bulkResultSchema, demoteResultSchema, DRAFT_GRACE_DAYS, limitsFor, studioErrorSchema } from "@kept/shared";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { inArray } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { pointerKey } from "../lib/storage/manifest";
import { r2Store } from "../lib/storage/r2";
import {
  bulkKeepRefusal,
  draftsDeletedToast,
  draftsKeptToast,
  formatTimestamp,
  publishedLabel,
} from "../lib/sites/display";

import { urlsFor, waitUntilGone } from "./live-publish";
import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import {
  cleanup,
  hydrated,
  newScope,
  publishOwned,
  readSite,
  seedKept,
  signInAs,
  SKIP_OWNER_UI,
} from "./owner-fixtures";

/**
 * The Pages home's Kept · Drafts tabs, against the REAL dev stack: the URL
 * state, the drafts tab's sorts, filters and search, a published date on every
 * draft, per-draft delete, Select mode with bulk keep / delete through
 * `POST /api/sites/bulk`, and the past-grace bug (a draft 40 days past its
 * clock was listed with a working Keep).
 *
 * NO MOCKS. Pages an assertion is about are published through `POST /api/sites`
 * by a real magic-link session; rows that only fill an account are real rows
 * inserted into Postgres (`seedKept`, `seedDraft`). Every write is re-read from
 * Postgres, and a deleted page's edge is probed until it stops serving.
 *
 * SKIPS without dev credentials: CI runs fork PRs with no secrets.
 */
const scope = newScope();
const FREE = limitsFor("free");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test.describe("the drafts tab", () => {
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

  /** An owned draft row straight into Postgres: first published `createdAt`, clock `expiresAt`. */
  async function seedDraft(
    ownerId: string,
    { createdAt = new Date(), expiresAt }: { createdAt?: Date; expiresAt: Date },
  ): Promise<{ siteId: string; slug: string; createdAt: Date }> {
    const id = crypto.randomUUID();
    const slug = `e06-draft-${id.slice(0, 8)}${id.slice(9, 13)}`;
    await db.insert(schema.sites).values({
      id,
      slug,
      ownerId,
      publisherHash: "e06-e2e-seed",
      claimedAt: createdAt,
      contentHash: "e06-e2e-seed",
      sizeBytes: 128,
      createdAt,
      expiresAt,
      purgeAfter: new Date(expiresAt.getTime() + DRAFT_GRACE_DAYS * DAY),
    });
    scope.siteIds.push(id);
    return { siteId: id, slug, createdAt };
  }

  /** Demote through the real route, so a published page becomes a real draft. */
  async function demote(page: Page, baseURL: string, siteId: string) {
    const response = await page.request.post(`${baseURL}/api/sites/${siteId}/demote`, {
      headers: { origin: new URL(baseURL).origin },
    });
    expect(response.status(), await response.text()).toBe(200);
    return demoteResultSchema.parse(await response.json());
  }

  const tab = (page: Page, name: "Kept" | "Drafts") => page.getByRole("tab", { name: new RegExp(`^${name}`) });
  const draftsList = (page: Page) => page.getByTestId("drafts-list");
  const card = (page: Page, siteId: string) =>
    page.locator(`[data-testid="home-card"][data-site-id="${siteId}"]`);
  const order = (list: Locator) =>
    list.locator('[data-testid="home-card"]').evaluateAll((items) =>
      items.map((item) => item.getAttribute("data-site-id")),
    );
  const summaryItem = (page: Page, label: string) =>
    page.getByRole("list", { name: "Summary" }).getByRole("listitem").filter({ hasText: label });

  test("tabs: Kept opens by default, each with its count; the tab is the URL; arrow keys move between them", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    const kept = await publishOwned(page, baseURL!, scope, "E06 tabs kept");
    const drafts = [
      await seedDraft(userId, { expiresAt: new Date(Date.now() + 3 * DAY) }),
      await seedDraft(userId, { expiresAt: new Date(Date.now() + 4 * DAY) }),
    ];

    await page.goto("/dashboard");
    await expect(tab(page, "Kept")).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, "Kept")).toHaveText(/Kept\s*1/);
    await expect(tab(page, "Drafts")).toHaveText(/Drafts\s*2/);
    // The counters stay above the tabs.
    await expect(summaryItem(page, "Drafts")).toContainText("2");
    await expect(page.getByTestId("kept-wall").locator(`[data-site-id="${kept.siteId}"]`)).toBeVisible();
    await expect(draftsList(page)).toHaveCount(0);

    await tab(page, "Drafts").click();
    await expect(page).toHaveURL(/[?&]tab=drafts\b/);
    await expect.poll(async () => (await order(draftsList(page))).sort()).toEqual(drafts.map((d) => d.siteId).sort());
    // Many drafts read better as a list: the drafts tab opens on one.
    await expect(draftsList(page)).toHaveAttribute("data-view", "list");
    await expect(page.getByTestId("kept-wall")).toHaveCount(0);

    await page.reload();
    await expect(tab(page, "Drafts")).toHaveAttribute("aria-selected", "true");
    await expect(draftsList(page)).toBeVisible();

    // Keyboard: the tablist is one stop, and the arrows move the selection.
    await tab(page, "Drafts").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(tab(page, "Kept")).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, "Kept")).toBeFocused();
    await expect(page).not.toHaveURL(/tab=/);
    await page.keyboard.press("ArrowRight");
    await expect(tab(page, "Drafts")).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/[?&]tab=drafts\b/);
  });

  test("drafts: newest published first, the other sorts, filter chips with counts, search, a published date, Grid / List", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    const now = Date.now();
    const a = await seedDraft(userId, { createdAt: new Date(now - 3 * DAY), expiresAt: new Date(now + 4 * DAY) });
    const urgent = await seedDraft(userId, { createdAt: new Date(now - DAY), expiresAt: new Date(now + 20 * HOUR) });
    const expired = await seedDraft(userId, { createdAt: new Date(now - 9 * DAY), expiresAt: new Date(now - DAY) });
    const d = await seedDraft(userId, { createdAt: new Date(now - 2 * DAY), expiresAt: new Date(now + 5 * DAY) });

    await page.goto("/dashboard?tab=drafts");
    const list = draftsList(page);

    // Default: newest published first.
    await expect(page.getByRole("button", { name: "Newest published" })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => order(list)).toEqual([urgent.siteId, d.siteId, a.siteId, expired.siteId]);

    await page.getByRole("button", { name: "Oldest published" }).click();
    await expect.poll(() => order(list)).toEqual([expired.siteId, a.siteId, d.siteId, urgent.siteId]);
    await page.getByRole("button", { name: "Expiring soonest" }).click();
    await expect.poll(() => order(list)).toEqual([expired.siteId, urgent.siteId, a.siteId, d.siteId]);
    await page.getByRole("button", { name: "Name", exact: true }).click();
    const byName = [a, urgent, expired, d].sort((x, y) => x.slug.localeCompare(y.slug)).map((x) => x.siteId);
    await expect.poll(() => order(list)).toEqual(byName);

    // Each draft says when it was first published, with the full stamp on hover.
    const published = card(page, a.siteId).getByText(publishedLabel(a.createdAt));
    await expect(published).toBeVisible();
    await expect(published).toHaveAttribute("title", formatTimestamp(a.createdAt));
    await expect(card(page, urgent.siteId).getByText(/^Draft · \d+ hours left$/)).toBeVisible();
    await expect(card(page, expired.siteId).getByText(/^Expired 1 day ago — keep within \d+ days$/)).toBeVisible();

    // Filter chips, each with its count.
    const chip = (name: string) => page.getByRole("group", { name: "Show" }).getByRole("button", { name: new RegExp(`^${name}`) });
    await expect(chip("All")).toHaveText(/All\s*4/);
    await expect(chip("Expiring soon")).toHaveText(/Expiring soon\s*1/);
    await expect(chip("Expired")).toHaveText(/Expired\s*1/);
    await chip("Expiring soon").click();
    await expect.poll(() => order(list)).toEqual([urgent.siteId]);
    await chip("Expired").click();
    await expect.poll(() => order(list)).toEqual([expired.siteId]);
    await chip("All").click();
    await expect.poll(async () => (await order(list)).length).toBe(4);

    // The search filters the open tab, and the tab counts follow it.
    const search = page.getByRole("searchbox", { name: "Search your pages" });
    await search.fill(a.slug);
    await expect.poll(() => order(list)).toEqual([a.siteId]);
    await expect(tab(page, "Drafts")).toHaveText(/Drafts\s*1/);
    await search.fill("zzz-nothing-here");
    await expect(page.getByText("No pages match 'zzz-nothing-here'.")).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect.poll(async () => (await order(list)).length).toBe(4);

    // Grid / List applies to the open tab and is the URL.
    await page.getByRole("button", { name: "Grid" }).click();
    await expect(list).toHaveAttribute("data-view", "grid");
    await expect(page).toHaveURL(/[?&]view=grid\b/);
    await page.getByRole("button", { name: "List" }).click();
    await expect(list).toHaveAttribute("data-view", "list");
    await expect(page).not.toHaveURL(/view=/);

    // Phone width: no horizontal page scroll.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(list).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("delete one draft: the trash asks, then the draft is archived and offline — and gone from the list", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const doomed = await publishOwned(page, baseURL!, scope, "E06 delete me");
    await demote(page, baseURL!, doomed.siteId);
    const neighbour = await publishOwned(page, baseURL!, scope, "E06 keep serving");
    await demote(page, baseURL!, neighbour.siteId);

    await page.goto("/dashboard?tab=drafts");
    await hydrated(page);
    await card(page, doomed.siteId).getByRole("button", { name: `Delete draft ${doomed.name}` }).click();

    const dialog = page.getByTestId("delete-drafts-dialog");
    await expect(dialog.getByRole("heading", { name: "Delete this draft?" })).toBeVisible();
    await expect(dialog).toContainText("It goes offline now.");
    await page.getByTestId("delete-drafts-dialog-confirm").click();

    await expect(page.getByText(draftsDeletedToast(1))).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    await expect(card(page, doomed.siteId)).toHaveCount(0);
    await expect(card(page, neighbour.siteId)).toBeVisible();

    // The owner DELETE's semantics (D14): archived, purge_after set, offline.
    const row = await readSite(doomed.siteId);
    expect(row.status).toBe("archived");
    expect(row.purgeAfter!.getTime()).toBeGreaterThan(Date.now() + (DRAFT_GRACE_DAYS - 1) * DAY);
    expect(await r2Store().get(pointerKey(doomed.slug))).toBeNull();
    await waitUntilGone(urlsFor(doomed.slug)[0]!);
    expect((await readSite(neighbour.siteId)).status).toBe("live");
  });

  test("Select mode: keyboard-reachable checkboxes, shift-click range, Esc leaves, and a bulk delete of N", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    // One kept page, so deleting every draft leaves a populated account (and
    // the Drafts tab's calm line) rather than the first-visit hero.
    await seedKept(scope, userId, 1);
    const now = Date.now();
    const drafts = [];
    for (let i = 0; i < 4; i++) {
      drafts.push(await seedDraft(userId, { createdAt: new Date(now - i * HOUR), expiresAt: new Date(now + 5 * DAY) }));
    }
    // Newest first: drafts[0] … drafts[3].

    await page.goto("/dashboard?tab=drafts");
    await hydrated(page);
    await page.getByTestId("select-drafts").click();
    const bar = page.getByTestId("selection-bar");
    await expect(bar).toContainText("0 selected");

    // Esc leaves Select mode.
    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);
    await page.getByTestId("select-drafts").click();

    // Keyboard: from the bar, Tab reaches the first draft's checkbox; Space ticks it.
    const box = (siteId: string) => card(page, siteId).getByTestId("select-draft");
    await bar.getByRole("button", { name: "Cancel" }).focus();
    for (let presses = 0; presses < 5; presses++) {
      await page.keyboard.press("Tab");
      if (await box(drafts[0]!.siteId).evaluate((el) => el === document.activeElement)) break;
    }
    await expect(box(drafts[0]!.siteId)).toBeFocused();
    await page.keyboard.press("Space");
    await expect(box(drafts[0]!.siteId)).toBeChecked();

    // Shift-click ticks the range from the last one clicked.
    await box(drafts[2]!.siteId).click({ modifiers: ["Shift"] });
    for (const draft of drafts.slice(0, 3)) await expect(box(draft.siteId)).toBeChecked();
    await expect(box(drafts[3]!.siteId)).not.toBeChecked();
    await expect(bar).toContainText("3 selected");

    await bar.getByRole("button", { name: "Clear" }).click();
    await expect(bar).toContainText("0 selected");
    await bar.getByRole("button", { name: "Select all (4 shown)" }).click();
    await expect(bar).toContainText("4 selected");

    await page.getByTestId("delete-selected").click();
    const dialog = page.getByTestId("delete-drafts-dialog");
    await expect(dialog.getByRole("heading", { name: "Delete 4 drafts?" })).toBeVisible();
    await expect(dialog).toContainText("They go offline now.");
    await page.getByTestId("delete-drafts-dialog-confirm").click();

    await expect(page.getByText(draftsDeletedToast(4))).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    await expect(bar).toHaveCount(0);
    await expect(page.getByTestId("drafts-empty")).toContainText("No drafts right now.");
    const rows = await db
      .select({ status: schema.sites.status, purgeAfter: schema.sites.purgeAfter })
      .from(schema.sites)
      .where(inArray(schema.sites.id, drafts.map((draft) => draft.siteId)));
    expect(rows.map((row) => row.status)).toEqual(["archived", "archived", "archived", "archived"]);
    for (const row of rows) expect(row.purgeAfter).not.toBeNull();
  });

  test("bulk keep: all or nothing within the free slots — over them Keep is off and says why; within them every one is kept", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    await seedKept(scope, userId, FREE.keptPages - 2);
    const drafts = [
      await seedDraft(userId, { expiresAt: new Date(Date.now() + 3 * DAY) }),
      await seedDraft(userId, { expiresAt: new Date(Date.now() + 4 * DAY) }),
      await seedDraft(userId, { expiresAt: new Date(Date.now() + 5 * DAY) }),
    ];

    await page.goto("/dashboard?tab=drafts");
    await hydrated(page);
    await page.getByTestId("select-drafts").click();
    const bar = page.getByTestId("selection-bar");
    await bar.getByRole("button", { name: "Select all (3 shown)" }).click();

    const keep = page.getByTestId("keep-selected");
    await expect(keep).toBeDisabled();
    await expect(bar).toContainText(bulkKeepRefusal(3, 2, FREE.keptPages)!);
    await expect(bar).toContainText("You can keep 2 more — select 2 or fewer.");

    // The server says the same if it is asked anyway — and keeps nothing.
    const forced = await page.request.post(`${baseURL}/api/sites/bulk`, {
      headers: { origin: new URL(baseURL!).origin },
      data: { action: "keep", ids: drafts.map((draft) => draft.siteId) },
    });
    expect(forced.status()).toBe(409);
    expect(studioErrorSchema.parse(await forced.json()).error.code).toBe("at_kept_limit");
    for (const draft of drafts) expect((await readSite(draft.siteId)).expiresAt).not.toBeNull();

    await card(page, drafts[2]!.siteId).getByTestId("select-draft").click();
    await expect(bar).toContainText("2 selected");
    await expect(keep).toBeEnabled();
    await keep.click();

    await expect(page.getByText(draftsKeptToast(2))).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    await expect(bar).toHaveCount(0);
    await expect.poll(() => order(draftsList(page))).toEqual([drafts[2]!.siteId]);
    await expect(tab(page, "Kept")).toHaveText(new RegExp(`Kept\\s*${FREE.keptPages}`));
    for (const draft of drafts.slice(0, 2)) {
      const row = await readSite(draft.siteId);
      expect(row.expiresAt).toBeNull();
      expect(row.purgeAfter).toBeNull();
    }
    expect((await readSite(drafts[2]!.siteId)).expiresAt).not.toBeNull();
  });

  test("a draft past its grace never appears and can never be kept — not on the tab, not by id, not in bulk", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    // Arun's screenshot: no expiry sweep has run, so the row still says `live`.
    const stale = await seedDraft(userId, {
      createdAt: new Date(Date.now() - 47 * DAY),
      expiresAt: new Date(Date.now() - 40 * DAY),
    });
    const fresh = await seedDraft(userId, { expiresAt: new Date(Date.now() + 2 * DAY) });
    const before = await readSite(stale.siteId);

    await page.goto("/dashboard?tab=drafts");
    await expect.poll(() => order(draftsList(page))).toEqual([fresh.siteId]);
    await expect(tab(page, "Drafts")).toHaveText(/Drafts\s*1/);
    await expect(summaryItem(page, "Drafts")).toContainText("1");
    await expect(page.getByText(/Expired 40 days ago/)).toHaveCount(0);

    const origin = { origin: new URL(baseURL!).origin };
    const single = await page.request.post(`${baseURL}/api/sites/${stale.siteId}/keep`, { headers: origin });
    expect(single.status()).toBe(404);
    expect(studioErrorSchema.parse(await single.json()).error.code).toBe("not_found");

    const bulk = await page.request.post(`${baseURL}/api/sites/bulk`, {
      headers: origin,
      data: { action: "keep", ids: [stale.siteId] },
    });
    expect(bulk.status()).toBe(200);
    const [result] = bulkResultSchema.parse(await bulk.json()).results;
    expect(result).toMatchObject({ id: stale.siteId, ok: false, code: "not_found" });

    await page.goto(`/site/${stale.siteId}`);
    await expect(page.getByTestId("site-not-found")).toBeVisible();
    expect(await readSite(stale.siteId)).toEqual(before);
  });

  test("an account with kept pages and no drafts: the Drafts tab says so calmly — no hero", async ({ page, baseURL }) => {
    await signInAs(page, baseURL!, scope);
    await publishOwned(page, baseURL!, scope, "E06 only kept");

    await page.goto("/dashboard?tab=drafts");
    await expect(page.getByTestId("drafts-empty")).toContainText("No drafts right now.");
    await expect(page.getByTestId("empty-state")).toHaveCount(0);
    await expect(page.getByTestId("select-drafts")).toBeDisabled();
  });
});
