import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { ensureProfile } from "../lib/db/queries/profile";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { cleanup, hydrated, newScope, seedKept, signInAs, SKIP_OWNER_UI } from "./owner-fixtures";

/**
 * The getting-started card on the Pages home — E10 task 010 (PRD §5.3, §9:
 * "3 steps with ticks, dismissible").
 *
 * Each tick is read from real rows: a kept page (`seedKept` — a real `sites`
 * row with no manifest, so 0 KV writes), the profile's handle, and one verified
 * referral from a second real account. The handle and the referral are written
 * straight to Postgres: this spec is about the card, and the routes that write
 * them have their own specs (`handles.spec.ts`, `profile-referrals.spec.ts`).
 *
 * Dismissal is the viewer's `localStorage`, so it survives a reload in the same
 * browser and nothing else.
 *
 * 0 KV writes. SKIPS without dev credentials.
 */
const scope = newScope();

test.describe("getting-started card", () => {
  test.skip(!!SKIP_OWNER_UI, String(SKIP_OWNER_UI));
  test.describe.configure({ mode: "serial", timeout: LIVE_STACK_TIMEOUT });
  test.beforeAll(warmDb);
  test.afterAll(async () => {
    await cleanup(scope);
    await closeDb();
  });

  test("ticks each step from live data, and is gone once all three are done", async ({ page, browser, baseURL }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    await seedKept(scope, userId, 1);

    await page.goto("/dashboard");
    await hydrated(page);
    const card = page.getByTestId("getting-started");
    await expect(card).toBeVisible();
    await expect(card.getByRole("heading", { name: "Make kept yours" })).toBeVisible();
    await expect(card.getByTestId("getting-started-kept")).toHaveAttribute("data-done", "true");
    await expect(card.getByTestId("getting-started-handle")).toHaveAttribute("data-done", "false");
    await expect(card.getByTestId("getting-started-referral")).toHaveAttribute("data-done", "false");
    await expect(card.getByRole("link", { name: /Claim your handle/ })).toHaveAttribute(
      "href",
      "/settings?section=profile",
    );
    await expect(card.getByRole("link", { name: /Share your referral link/ })).toHaveAttribute("href", "/referrals");

    // The handle step's link opens Settings on Profile.
    await card.getByRole("link", { name: /Claim your handle/ }).click();
    await expect(page.getByTestId("settings-section-profile")).toBeVisible();

    const handle = `gs${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
    await db.update(schema.profiles).set({ handle }).where(eq(schema.profiles.id, userId));
    await page.goto("/dashboard");
    await hydrated(page);
    await expect(card.getByTestId("getting-started-handle")).toHaveAttribute("data-done", "true");
    await expect(card.getByTestId("getting-started-referral")).toHaveAttribute("data-done", "false");

    // A second real account, referred by the first and verified.
    const other = await browser.newPage();
    try {
      const referred = await signInAs(other, baseURL!, scope);
      await ensureProfile({ userId: referred.userId, email: referred.email });
      await db
        .insert(schema.referrals)
        .values({ referredId: referred.userId, referrerId: userId, verifiedAt: new Date() });
    } finally {
      await other.close();
    }

    await page.goto("/dashboard");
    await hydrated(page);
    await expect(page.getByTestId("kept-wall")).toBeVisible();
    await expect(page.getByTestId("getting-started")).toHaveCount(0);
  });

  test("dismiss hides it, and it stays hidden after a reload in the same browser", async ({ page, baseURL }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    await seedKept(scope, userId, 1);

    await page.goto("/dashboard");
    await hydrated(page);
    const card = page.getByTestId("getting-started");
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Dismiss" }).click();
    await expect(card).toHaveCount(0);

    await page.reload();
    await hydrated(page);
    await expect(page.getByTestId("kept-wall")).toBeVisible();
    await expect(page.getByTestId("getting-started")).toHaveCount(0);

    // Storage cleared (a private window, a cleared site): it renders again.
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await hydrated(page);
    await expect(page.getByTestId("getting-started")).toBeVisible();
  });
});
