import { test, expect, type Page } from "@playwright/test";

/**
 * Stub route smoke: /dashboard, /auth, /stats and /promise.
 *
 * These are placeholder shells (the real surfaces land in E2/E3 and E09). We
 * assert they respond OK, render their stable placeholder heading, and produce
 * no console errors — plus, for /stats, that the pre-launch zero baseline is
 * reported honestly rather than filled in with an invented figure.
 */
function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

test.describe("stub routes", () => {
  test("/dashboard responds and renders its placeholder", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const res = await page.goto("/dashboard");
    expect(res?.ok()).toBe(true);
    await expect(
      page.getByRole("heading", { name: "Dashboard placeholder" }),
    ).toBeVisible();
    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("/auth responds and renders its placeholder", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const res = await page.goto("/auth");
    expect(res?.ok()).toBe(true);
    await expect(
      page.getByRole("heading", { name: "Sign-in placeholder" }),
    ).toBeVisible();
    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("/stats responds and reports the zero baseline honestly", async ({
    page,
  }) => {
    const errors = trackConsoleErrors(page);
    const res = await page.goto("/stats");
    expect(res?.ok()).toBe(true);
    await expect(page).toHaveTitle("Stats · kept");
    await expect(page.getByRole("heading", { name: "Stats" })).toBeVisible();

    // Nothing is deployed yet, so the figures must read as a real zero and an
    // unmeasured uptime — never a placeholder number or an unearned 100%.
    const figures = page.locator("dl > div");
    await expect(figures).toHaveCount(3);
    await expect(
      figures.filter({ hasText: "Pages kept" }).locator("dd"),
    ).toHaveText("0");
    await expect(
      figures.filter({ hasText: "Uptime" }).locator("dd"),
    ).toHaveText("Not yet measured");
    await expect(
      figures.filter({ hasText: "Infra cost this month" }).locator("dd"),
    ).toHaveText("€0.00");

    const bodyText = await page.evaluate(() => document.body.innerText ?? "");
    expect(bodyText).not.toMatch(/100%/);
    expect(bodyText).not.toMatch(/1,?284/);

    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("/promise responds and states the wind-down commitment", async ({
    page,
  }) => {
    const errors = trackConsoleErrors(page);
    const res = await page.goto("/promise");
    expect(res?.ok()).toBe(true);
    await expect(page).toHaveTitle("The promise · kept");
    await expect(
      page.getByRole("heading", { name: "If kept ever winds down" }),
    ).toBeVisible();
    await expect(page.getByText(/we announce the sunset/)).toBeVisible();
    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("/promise reports the same zero baseline vocabulary as /stats", async ({
    page,
  }) => {
    await page.goto("/promise");

    // The wind-down promise is what replaced the donation ask; neither the
    // funding vocabulary nor an unearned uptime figure may appear here.
    const bodyText = await page.evaluate(() => document.body.innerText ?? "");
    expect(bodyText).not.toMatch(/Open Collective/i);
    expect(bodyText).not.toMatch(/donat/i);
    expect(bodyText).not.toMatch(/supporter/i);
    expect(bodyText).not.toMatch(/100%/);
  });

  test("both marketing routes link back to the landing page", async ({
    page,
  }) => {
    for (const route of ["/stats", "/promise"]) {
      await page.goto(route);
      const back = page.getByRole("link", { name: /Back to kept/ });
      await expect(back).toHaveCount(1);
      await expect(back).toHaveAttribute("href", "/");

      // The link actually navigates — the landing page is the destination.
      await back.click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page).toHaveTitle("kept");
    }
  });
});
