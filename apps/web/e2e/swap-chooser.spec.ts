import { limitsFor } from "@kept/shared";
import { expect, test, type Page } from "@playwright/test";
import { and, eq, isNull, notInArray } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { SWAPPED_TOAST, swapConsequence } from "../lib/sites/display";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import {
  cleanup,
  newScope,
  publishOwned,
  readSite,
  seedKept,
  signInAs,
  SKIP_OWNER_UI,
  type OwnedPage,
  type SeededPage,
} from "./owner-fixtures";

/**
 * The swap chooser, driven from both surfaces that mount it — E06 tasks 011
 * (AC12, UI half) and 013.
 *
 * NO MOCKS. `POST /api/sites/swap` runs `swapKept` in one Postgres transaction
 * and `owner-sites-api.spec.ts` already proves it atomic. This spec proves the
 * moment before it: pick (least visited first, searchable) → confirm (the
 * demote warning naming both pages) → done ("Swapped.", and both cards move
 * with the refresh that follows — PRD §5.1: no live updates).
 *
 * The account's kept pages are real rows SEEDED by direct insert (`seedKept`);
 * their visits are real `page_views_daily` rows. The draft being kept is
 * published for real.
 *
 * SKIPS without dev credentials: CI runs fork PRs with no secrets.
 */
const scope = newScope();

/** Every account here is new, and new accounts are free. Never a typed limit. */
const FREE_LIMIT = limitsFor("free").keptPages;

test.describe("the swap chooser", () => {
  test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
  test.describe.configure({ timeout: LIVE_STACK_TIMEOUT });

  test.beforeAll(async () => {
    if (SKIP_OWNER_UI) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_OWNER_UI) return;
    await cleanup(scope);
    await closeDb();
  });

  /**
   * A signed-in account holding exactly its limit of kept pages plus one owned
   * draft — the only state in which this dialog opens from a Keep.
   */
  async function accountAtCap(
    page: Page,
    baseURL: string,
  ): Promise<{ kept: SeededPage[]; draft: OwnedPage; ownerId: string }> {
    const { userId } = await signInAs(page, baseURL, scope);
    const kept = await seedKept(scope, userId, FREE_LIMIT);
    const draft = await publishOwned(page, baseURL, scope, "E06 swap draft");
    expect(draft.outcome, "the cap degrades to a draft, it never errors").toBe("owned_draft");
    return { kept, draft, ownerId: userId };
  }

  /** How many kept pages the account really holds, by the enforcer's own rule. */
  async function countKept(ownerId: string): Promise<number> {
    const rows = await db
      .select({ id: schema.sites.id })
      .from(schema.sites)
      .where(
        and(
          eq(schema.sites.ownerId, ownerId),
          isNull(schema.sites.expiresAt),
          notInArray(schema.sites.status, ["archived", "removed"]),
        ),
      );
    return rows.length;
  }

  async function seedVisits(siteId: string, views: number) {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await db.insert(schema.pageViewsDaily).values({ siteId, day: yesterday, views });
  }

  test("AC12: least visited first, searchable, a confirm step naming both pages, then Swapped. and both cards move", async ({
    page,
    baseURL,
  }) => {
    const { kept, draft, ownerId } = await accountAtCap(page, baseURL!);
    const [mostVisited, someVisits] = kept;
    await seedVisits(mostVisited!.siteId, 30);
    await seedVisits(someVisits!.siteId, 10);

    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    // At the limit the draft's action reads Swap… and sends nothing: it opens
    // the chooser.
    const draftCard = page.locator(`[data-testid="home-card"][data-site-id="${draft.siteId}"]`);
    await expect(draftCard.getByTestId("keep-button")).toHaveText(/^Swap…/);
    await draftCard.getByTestId("keep-button").click();

    const dialog = page.getByTestId("swap-dialog");
    await expect(dialog).toBeVisible();
    // The page being kept is never offered.
    await expect(dialog.getByTestId(`swap-candidate-${draft.slug}`)).toHaveCount(0);

    // LEAST VISITED FIRST: pages with no data count as none, so the two with
    // visits come last, the busier one at the very end.
    const candidates = dialog.locator('label[data-testid^="swap-candidate-"]');
    const order = await candidates.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-testid")),
    );
    expect(order).toHaveLength(FREE_LIMIT);
    expect(order.at(-1)).toBe(`swap-candidate-${mostVisited!.slug}`);
    expect(order.at(-2)).toBe(`swap-candidate-${someVisits!.slug}`);

    // Searchable.
    const victim = kept[2]!;
    await dialog.getByTestId("swap-search").fill(victim.slug);
    await expect(candidates).toHaveCount(1);
    await dialog.getByTestId(`swap-candidate-${victim.slug}`).click();

    // Nothing is written at the pick — the next step is the warning.
    expect((await readSite(victim.siteId)).expiresAt).toBeNull();
    await dialog.getByTestId("swap-next").click();
    await expect(dialog.getByTestId("swap-consequence")).toHaveText(
      swapConsequence(victim.name, draft.name),
    );

    await dialog.getByTestId("swap-confirm").click();
    await expect(dialog).toBeHidden({ timeout: LIVE_STACK_TIMEOUT });
    await expect(page.getByText(SWAPPED_TOAST)).toBeVisible();

    // Both cards move with the refresh: the draft onto the wall, the victim
    // into the drafts strip.
    await expect(
      page.getByTestId("kept-wall").locator(`[data-site-id="${draft.siteId}"]`),
    ).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    await expect(
      page.getByTestId("drafts-strip").locator(`[data-site-id="${victim.siteId}"]`),
    ).toBeVisible();

    expect((await readSite(draft.siteId)).expiresAt).toBeNull();
    expect((await readSite(victim.siteId)).expiresAt).not.toBeNull();
    expect(
      await countKept(ownerId),
      "a swap trades one for one — it can never take the account over the cap",
    ).toBe(FREE_LIMIT);
  });

  test("swapping the page you are looking at updates that screen", async ({
    page,
    baseURL,
  }) => {
    const { kept, draft, ownerId } = await accountAtCap(page, baseURL!);

    // The detail screen of the DRAFT, routed by its id (D2).
    await page.goto(`/site/${draft.siteId}`);
    await expect(page.getByText(/^Draft · /)).toBeVisible();

    await page.getByTestId("keep-button").click();
    const dialog = page.getByTestId("swap-dialog");
    await expect(dialog).toBeVisible();

    const victim = kept[1]!;
    await dialog.getByTestId(`swap-candidate-${victim.slug}`).click();
    await dialog.getByTestId("swap-next").click();
    await expect(dialog.getByTestId("swap-consequence")).toHaveText(
      swapConsequence(victim.name, draft.name),
    );
    await page.getByTestId("swap-confirm").click();
    await expect(dialog).toBeHidden({ timeout: LIVE_STACK_TIMEOUT });

    // THIS screen now says the page is kept: the countdown is gone and the verb
    // on offer has become demote, because there is nothing left to keep.
    await expect(page.getByText(/^Draft · /)).toHaveCount(0);
    await expect(page.getByTestId("demote-button")).toBeVisible();
    await expect(page.getByTestId("keep-button")).toHaveCount(0);

    expect((await readSite(draft.siteId)).expiresAt).toBeNull();
    expect((await readSite(victim.siteId)).expiresAt).not.toBeNull();
    expect(await countKept(ownerId)).toBe(FREE_LIMIT);
  });
});
