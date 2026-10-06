import { limitsFor, ownedPublishResultSchema } from "@kept/shared";
import { expect, test } from "@playwright/test";
import { and, eq, isNull, notInArray } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { atLimitPublishToast, SWAPPED_TOAST } from "../lib/sites/display";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { pageHtml, publishViaApi, urlsFor, waitForBytes } from "./live-publish";
import {
  cleanup,
  drop,
  hydrated,
  newScope,
  readSite,
  seedKept,
  seedVisits,
  signInAs,
  SKIP_OWNER_UI,
  titledHtml,
} from "./owner-fixtures";

/**
 * The epic's acceptance story, in a real browser against the real dev stack —
 * E06 task 014.
 *
 *   1. **AC2 + AC12.** An account holding its whole free allowance of kept
 *      pages publishes one more from the studio: it lands as an owned draft
 *      with the at-limit toast, never an error. Its action is Swap…, the
 *      chooser lists the kept pages least-visited first (seeded
 *      `page_views_daily`, a distinct count per page, so the order is a fact
 *      and not a tie), and confirming swaps the least-visited page out.
 *   2. **Edge case 22.** A person with an unclaimed anonymous draft publishes
 *      the SAME bytes from the studio: a page of their own, not a dedup onto
 *      the anonymous one (dedup is owner-scoped), and the E05 claim flow still
 *      keeps the anonymous draft afterwards. Edge case 21 — the anonymous
 *      `/p/[anonToken]` and `/keep/[anonToken]` flows unchanged — is the
 *      existing anon specs, run unmodified.
 *
 * The kept allowance is seeded rows (`seedKept`), never typed: the limit is
 * `limitsFor("free")`. NO MOCKS. SKIPS without dev credentials.
 */

const FREE = limitsFor("free");

test.describe("the studio story", () => {
  test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
  test.describe.configure({ timeout: LIVE_STACK_TIMEOUT * 2 });

  const scope = newScope();

  test.beforeAll(async () => {
    if (SKIP_OWNER_UI) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_OWNER_UI) return;
    await cleanup(scope);
    await closeDb();
  });

  /** How many kept pages the account holds, by the enforcer's own rule. */
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

  test("AC2 + AC12: at the free limit the next studio publish lands as a draft with the at-limit toast; Swap… offers the least-visited page first and swaps it out", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    const kept = await seedKept(scope, userId, FREE.keptPages);
    // Visits fall with creation order, so least-visited-first is the REVERSE of
    // the order the pages were made — a sort that merely kept insertion order
    // would fail here.
    await Promise.all(kept.map((site, i) => seedVisits(site.siteId, FREE.keptPages - i)));
    expect(await countKept(userId)).toBe(FREE.keptPages);

    await page.goto("/dashboard");
    await hydrated(page);

    const title = `E06 story ${crypto.randomUUID().slice(0, 8)}`;
    await drop(page, page.getByRole("heading", { level: 1, name: "Your pages" }), {
      name: "one-more.html",
      body: titledHtml(title),
    });
    await expect(page.getByText(atLimitPublishToast(FREE.keptPages))).toBeVisible({
      timeout: LIVE_STACK_TIMEOUT,
    });
    const [row] = await db
      .select({ id: schema.sites.id, slug: schema.sites.slug, expiresAt: schema.sites.expiresAt })
      .from(schema.sites)
      .where(and(eq(schema.sites.ownerId, userId), eq(schema.sites.title, title)));
    expect(row, "the publish created the page").toBeDefined();
    scope.siteIds.push(row!.id);
    scope.slugs.add(row!.slug);
    expect(row!.expiresAt, "past the limit a publish is an owned draft, never an error").not.toBeNull();
    expect(await countKept(userId)).toBe(FREE.keptPages);

    // Swap…: the chooser, least visited first — on the Drafts tab, which the
    // at-limit publish opened.
    await expect(page.getByRole("tab", { name: /^Drafts/ })).toHaveAttribute("aria-selected", "true");
    const draftCard = page.getByTestId("drafts-list").locator(`[data-site-id="${row!.id}"]`);
    await expect(draftCard.getByTestId("keep-button")).toHaveText(/^Swap…/);
    await draftCard.getByTestId("keep-button").click();
    const dialog = page.getByTestId("swap-dialog");
    await expect(dialog).toBeVisible();
    const candidates = dialog.locator('label[data-testid^="swap-candidate-"]');
    expect(
      await candidates.evaluateAll((rows) => rows.map((node) => node.getAttribute("data-testid"))),
    ).toEqual([...kept].reverse().map((site) => `swap-candidate-${site.slug}`));

    const leastVisited = kept.at(-1)!;
    await candidates.first().click();
    await dialog.getByTestId("swap-next").click();
    await dialog.getByTestId("swap-confirm").click();
    await expect(dialog).toBeHidden({ timeout: LIVE_STACK_TIMEOUT });
    await expect(page.getByText(SWAPPED_TOAST)).toBeVisible();
    await expect(
      page.getByTestId("drafts-list").locator(`[data-site-id="${leastVisited.siteId}"]`),
    ).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    await page.getByRole("tab", { name: /^Kept/ }).click();
    await expect(page.getByTestId("kept-wall").locator(`[data-site-id="${row!.id}"]`)).toBeVisible();

    expect((await readSite(row!.id)).expiresAt, "the draft is kept").toBeNull();
    expect((await readSite(leastVisited.siteId)).expiresAt, "the least visited is a draft").not.toBeNull();
    expect(await countKept(userId), "one for one").toBe(FREE.keptPages);
  });

  test("edge case 22: a studio publish of the same bytes as an unclaimed anonymous draft is a page of its own, and the claim flow still keeps the draft", async ({
    page,
    request,
    baseURL,
  }) => {
    // The anonymous draft, published keyless exactly as the landing does.
    const html = pageHtml(`e06-014-story-anon-${crypto.randomUUID().slice(0, 8)}`);
    const anonymous = await publishViaApi(request, html);
    expect(anonymous.status(), await anonymous.text()).toBe(201);
    const { slug: anonSlug, anonToken } = (await anonymous.json()) as { slug: string; anonToken: string };
    const [anonRow] = await db
      .select({ id: schema.sites.id })
      .from(schema.sites)
      .where(eq(schema.sites.slug, anonSlug));
    scope.siteIds.push(anonRow!.id);
    scope.slugs.add(anonSlug);

    // The same person, signed in, publishes the same bytes from the studio.
    const { userId } = await signInAs(page, baseURL!, scope);
    const studio = await page.request.post(`${baseURL}/api/sites`, {
      headers: { origin: new URL(baseURL!).origin, "content-type": "text/html" },
      data: html,
    });
    expect(studio.status(), `a new page, never a dedup onto the anonymous one: ${await studio.text()}`).toBe(201);
    const { site } = ownedPublishResultSchema.parse(await studio.json());
    scope.siteIds.push(site.id);
    scope.slugs.add(site.slug);
    expect(site.id).not.toBe(anonRow!.id);
    expect(site.expiresAt, "under the limit the studio page is kept").toBeNull();
    const studioBefore = await readSite(site.id);
    expect((await readSite(anonRow!.id)).ownerId, "the anonymous draft is untouched").toBeNull();

    // The E05 claim flow, signed in: straight to the outcome.
    await page.goto(`/keep/${anonToken}`);
    await page.getByRole("button", { name: "Keep it forever" }).click();
    await expect(page).toHaveURL(/\/auth\/callback\/done\?outcome=kept/, { timeout: LIVE_STACK_TIMEOUT });
    await expect(page.getByRole("heading", { name: "Kept forever" })).toBeVisible();

    const claimed = await readSite(anonRow!.id);
    expect(claimed.ownerId).toBe(userId);
    expect(claimed.expiresAt, "kept forever").toBeNull();
    expect(claimed.anonTokenHash, "the token died with the claim").toBeNull();
    expect(await readSite(site.id), "the studio page did not move").toEqual(studioBefore);

    // Both serve, each at its own name.
    await waitForBytes(urlsFor(anonSlug)[0]!, html);
    await waitForBytes(urlsFor(site.slug)[0]!, html);
  });
});
