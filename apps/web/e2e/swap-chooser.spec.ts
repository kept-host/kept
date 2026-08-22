import { KEPT_PAGE_LIMIT } from "@kept/shared";
import { expect, test, type Page } from "@playwright/test";
import { and, eq, isNull } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { swapConsequence } from "../lib/sites/display";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import {
  cleanup,
  newScope,
  publishOwned,
  readSite,
  signInAs,
  SKIP_OWNER_UI,
  type OwnedPage,
} from "./owner-fixtures";

/**
 * The swap chooser, driven from both surfaces that mount it — E06 task 013,
 * verification criterion **9**.
 *
 * NO MOCKS. `POST /api/sites/swap` runs `swapKept` in one Postgres transaction
 * and `owner-sites-api.spec.ts` already proves that transaction is atomic. What
 * that spec cannot prove is the moment before it: that the chooser names BOTH
 * pages, states the consequence in `DRAFT_TTL_DAYS` terms, and — the part with
 * no server-side equivalent at all — that both cards repaint from the SINGLE
 * response without a refetch.
 *
 * ── WHY "FROM THE SINGLE RESPONSE" IS THE ASSERTION AND NOT "EVENTUALLY" ─────
 *
 * `SwapResult` carries both halves and a post-swap `KeptQuota` on each precisely
 * so the screen never has to ask again. A test that reloaded and then found the
 * right state would pass against an implementation that guessed, refetched, or
 * repainted optimistically and disagreed with the committed transaction. So the
 * assertions below happen on the SAME page instance, with no navigation between
 * the confirm and the check.
 *
 * SKIPS without dev credentials: CI runs fork PRs with no secrets.
 */
const scope = newScope();

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
   * An account holding exactly `KEPT_PAGE_LIMIT` kept pages plus one owned
   * draft — the only state in which this dialog exists.
   */
  async function accountAtCap(
    page: Page,
    baseURL: string,
  ): Promise<{ kept: OwnedPage[]; draft: OwnedPage }> {
    await signInAs(page, baseURL, scope);
    const kept: OwnedPage[] = [];
    for (let i = 0; i < KEPT_PAGE_LIMIT; i += 1) {
      const owned = await publishOwned(page, baseURL, scope, `E06 swap kept ${i}`);
      expect(owned.outcome).toBe("kept");
      kept.push(owned);
    }
    const draft = await publishOwned(page, baseURL, scope, "E06 swap draft");
    expect(draft.outcome, "the cap degrades to a draft, it never errors").toBe(
      "owned_draft",
    );
    return { kept, draft };
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
          eq(schema.sites.status, "live"),
        ),
      );
    return rows.length;
  }

  test("the chooser names both pages, states the consequence, and flips both cards from one response", async ({
    page,
    baseURL,
  }) => {
    const { kept, draft, ownerId } = await signInAsAndBuild(page, baseURL!);

    await page.goto("/dashboard");

    // At the cap the Keep button sends NO request — it opens the chooser. That
    // is the whole reason this dialog exists, and a keep that fired a POST here
    // would be the cap behaving like an error.
    const draftCard = page.locator("article").filter({ hasText: draft.name });
    await draftCard.getByTestId("keep-button").click();

    const dialog = page.getByTestId("swap-dialog");
    await expect(dialog).toBeVisible();
    // The page being kept is never offered as a sacrifice — `demote === keep` is
    // unconstructable from this UI, which is why the route's only 400 is
    // unreachable here.
    await expect(dialog.getByTestId(`swap-candidate-${draft.slug}`)).toHaveCount(0);

    // Before a choice, the consequence line says nothing it cannot yet know.
    const consequence = dialog.getByTestId("swap-consequence");
    await expect(consequence).toContainText("Pick a page above");

    const victim = kept[0]!;
    await dialog.getByTestId(`swap-candidate-${victim.slug}`).click();

    // BOTH PAGES NAMED, AND THE WINDOW IN `DRAFT_TTL_DAYS` TERMS. Asserted
    // against the shared function, so a literal `7` typed into the dialog would
    // fail here as well as in the unit suite.
    await expect(consequence).toHaveText(swapConsequence(victim.name, draft.name));

    // Nothing is written until the button is pressed.
    expect((await readSite(victim.siteId)).expiresAt).toBeNull();

    await page.getByTestId("swap-confirm").click();
    await expect(dialog).toBeHidden({ timeout: LIVE_STACK_TIMEOUT });
    await expect(page.getByTestId("swap-error")).toHaveCount(0);

    // ── BOTH CARDS, FROM THE ONE RESPONSE, WITHOUT A NAVIGATION ──────────────
    // The demoted page grows a countdown and says it will regroup on the next
    // load; the kept page loses its. Neither card was refetched.
    await expect(draftCard.getByText(/^Draft · /)).toHaveCount(0);
    await expect(draftCard.getByText("Moves into Kept next time this screen loads.")).toBeVisible();

    const victimCard = page.locator("article").filter({ hasText: victim.name });
    await expect(victimCard.getByText(/^Draft · /)).toBeVisible();
    await expect(
      victimCard.getByText("Moves into Drafts next time this screen loads."),
    ).toBeVisible();

    // The header quota came off the same parsed `KeptQuota`, so it cannot
    // disagree — the account is still exactly full, never over.
    await expect(
      page.locator("header").getByText(`Kept · ${KEPT_PAGE_LIMIT} of ${KEPT_PAGE_LIMIT}`),
    ).toBeVisible();

    // And the database agrees with all of it.
    expect((await readSite(draft.siteId)).expiresAt).toBeNull();
    expect((await readSite(victim.siteId)).expiresAt).not.toBeNull();
    expect(
      await countKept(ownerId),
      "a swap trades one for one — it can never take the account over the cap",
    ).toBe(KEPT_PAGE_LIMIT);
  });

  test("swapping the page you are looking at updates that screen", async ({
    page,
    baseURL,
  }) => {
    const { kept, draft, ownerId } = await signInAsAndBuild(page, baseURL!);

    // The detail screen of the DRAFT — the page about to be kept. Its own Keep
    // button is the one that opens the chooser here, and the screen it updates
    // is the one being read.
    await page.goto(`/site/${draft.slug}`);
    await expect(page.getByText(/^Draft · /)).toBeVisible();

    await page.getByTestId("keep-button").click();
    const dialog = page.getByTestId("swap-dialog");
    await expect(dialog).toBeVisible();

    const victim = kept[1]!;
    await dialog.getByTestId(`swap-candidate-${victim.slug}`).click();
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
    expect(await countKept(ownerId)).toBe(KEPT_PAGE_LIMIT);
  });

  /**
   * `accountAtCap`, plus the owner id every assertion above re-counts against.
   *
   * `profiles.id` IS the user id — it is a primary key referencing `user.id`, so
   * there is no second identifier to look up and no join to get wrong.
   */
  async function signInAsAndBuild(page: Page, baseURL: string) {
    const before = scope.userIds.length;
    const { kept, draft } = await accountAtCap(page, baseURL);
    return { kept, draft, ownerId: scope.userIds[before]! };
  }
});
