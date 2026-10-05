import { expect, test, type Page } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { PUBLISHED_KEPT_TOAST, REPLACED_TOAST } from "../lib/sites/display";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import {
  cleanup,
  hold,
  hydrated,
  newScope,
  publishOwned,
  readSite,
  signInAs,
  titledHtml,
  SKIP_OWNER_UI,
} from "./owner-fixtures";

/**
 * One drop, one owner — Arun's manual test after E06 task 015.
 *
 * "I dropped a modified HTML file on top of an existing page card, but it
 * created a NEW page and ALSO saved a new version of the existing page." A file
 * dropped on a card must replace THAT page and nothing else; a file dropped
 * anywhere else must publish exactly one new page and replace nothing.
 *
 * The drops go through Chromium's own input pipeline (`hold` in
 * `owner-fixtures.ts`), which is what made the bug visible: the card took the
 * drop and re-rendered before the window's listener ran, and that listener,
 * no longer able to see the card it landed on, published the file too.
 *
 * Every outcome is read back from Postgres — the account's pages and the
 * target's versions — and from the requests the screen actually sent.
 *
 * NO MOCKS: a real magic-link session, real pages through `POST /api/sites`, a
 * real replace through `POST /api/sites/:id/replace`. SKIPS without dev
 * credentials, as every signed-in screen spec does.
 */
const scope = newScope();

test.describe("one drop, one owner", () => {
  test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
  test.describe.configure({ timeout: LIVE_STACK_TIMEOUT * 2 });

  test.beforeAll(async () => {
    if (SKIP_OWNER_UI) return;
    await warmDb();
  });

  // Whatever an account ended up owning — a page a drop published by mistake
  // included — is collected, so a failing run leaves nothing serving.
  test.afterEach(async () => {
    if (SKIP_OWNER_UI || scope.userIds.length === 0) return;
    const owned = await db
      .select({ id: schema.sites.id, slug: schema.sites.slug })
      .from(schema.sites)
      .where(inArray(schema.sites.ownerId, scope.userIds));
    for (const { id, slug } of owned) {
      if (!scope.siteIds.includes(id)) scope.siteIds.push(id);
      scope.slugs.add(slug);
    }
  });

  test.afterAll(async () => {
    if (SKIP_OWNER_UI) return;
    await cleanup(scope);
    await closeDb();
  });

  const ownedIds = async (userId: string) =>
    (
      await db
        .select({ id: schema.sites.id })
        .from(schema.sites)
        .where(eq(schema.sites.ownerId, userId))
    )
      .map(({ id }) => id)
      .sort();

  const versionIds = async (siteId: string) =>
    (
      await db
        .select({ id: schema.siteVersions.id })
        .from(schema.siteVersions)
        .where(eq(schema.siteVersions.siteId, siteId))
    ).map(({ id }) => id);

  /** Every publish and every replace the screen sends, from the moment it is called. */
  function watchWrites(page: Page) {
    const writes = { publishes: 0, replaces: [] as string[] };
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const path = new URL(request.url()).pathname;
      if (path === "/api/sites") writes.publishes += 1;
      const replace = /^\/api\/sites\/([^/]+)\/replace$/.exec(path);
      if (replace) writes.replaces.push(replace[1]!);
    });
    return writes;
  }

  const card = (page: Page, siteId: string) =>
    page.locator(`[data-testid="home-card"][data-site-id="${siteId}"]`);

  for (const variant of ["grid", "list", "draft"] as const) {
    test(`a file dropped on a ${variant} card replaces that page and publishes nothing`, async ({
      page,
      baseURL,
    }) => {
      const { userId } = await signInAs(page, baseURL!, scope);
      const target = await publishOwned(page, baseURL!, scope, `E06 card drop ${variant}`);
      if (variant === "draft") {
        // Demoted through the real route: a live draft in the strip takes a drop too.
        const response = await page.request.post(`${baseURL}/api/sites/${target.siteId}/demote`, {
          headers: { origin: new URL(baseURL!).origin },
        });
        expect(response.status(), await response.text()).toBe(200);
      }
      const pagesBefore = await ownedIds(userId);
      const versionsBefore = await versionIds(target.siteId);
      const liveBefore = (await readSite(target.siteId)).currentVersionId;

      await page.goto(variant === "list" ? "/dashboard?view=list" : "/dashboard");
      await hydrated(page);
      if (variant === "draft") await expect(page.getByTestId("drafts-strip")).toContainText(target.name);
      else await expect(page.getByTestId("kept-wall")).toHaveAttribute("data-view", variant);
      const writes = watchWrites(page);

      // Held over the card: the card says what the drop will do, the window does not.
      const held = await hold(page, card(page, target.siteId).locator("article"), {
        name: "modified.html",
        body: titledHtml(`E06 modified ${crypto.randomUUID().slice(0, 8)}`),
      });
      await expect(card(page, target.siteId).getByText("Drop to replace this page")).toBeVisible();
      await expect(page.getByTestId("drop-overlay-window")).toHaveCount(0);

      await held.drop();
      await expect(
        page.locator("[data-sonner-toast]").filter({ hasText: REPLACED_TOAST }),
      ).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });

      // By the time the replace has answered, a publish fired by the same drop
      // has long been sent — it would have left before the replace's response.
      expect(writes.replaces, "exactly one replace, of the card that was dropped on").toEqual([
        target.siteId,
      ]);
      expect(writes.publishes, "a drop on a card publishes nothing").toBe(0);
      await expect(page.getByTestId("mint-card")).toHaveCount(0);

      expect(await ownedIds(userId), "the account owns the same pages it did before").toEqual(
        pagesBefore,
      );
      const versionsAfter = await versionIds(target.siteId);
      expect(versionsAfter, "exactly one new version on the page dropped on").toHaveLength(
        versionsBefore.length + 1,
      );
      expect(versionsAfter).toEqual(expect.arrayContaining(versionsBefore));
      const live = (await readSite(target.siteId)).currentVersionId;
      expect(live, "the new version is the live one").not.toBe(liveBefore);
      expect(versionsBefore, "and it is the new one").not.toContain(live);
    });
  }

  test("a file dropped off every card publishes exactly one new page and replaces nothing", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    const neighbour = await publishOwned(page, baseURL!, scope, "E06 window drop neighbour");
    const pagesBefore = await ownedIds(userId);
    const neighbourVersions = await versionIds(neighbour.siteId);

    await page.goto("/dashboard");
    await hydrated(page);
    const writes = watchWrites(page);

    const held = await hold(page, page.getByRole("heading", { level: 1, name: "Your pages" }), {
      name: "window.html",
      body: titledHtml(`E06 window drop ${crypto.randomUUID().slice(0, 8)}`),
    });
    await expect(page.getByTestId("drop-overlay-window")).toBeVisible();
    await expect(page.getByText("Drop to replace this page")).toHaveCount(0);

    await held.drop();
    await expect(page.getByText(PUBLISHED_KEPT_TOAST)).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });

    expect(writes.publishes, "exactly one publish").toBe(1);
    expect(writes.replaces, "a drop off every card replaces nothing").toEqual([]);
    const pagesAfter = await ownedIds(userId);
    expect(pagesAfter, "exactly one new page").toHaveLength(pagesBefore.length + 1);
    expect(pagesAfter).toEqual(expect.arrayContaining(pagesBefore));
    expect(await versionIds(neighbour.siteId), "the card it missed is untouched").toEqual(
      neighbourVersions,
    );
  });
});
