import { test, expect, type Page } from "@playwright/test";

/**
 * Stub route smoke: /dashboard and /auth.
 *
 * These are placeholder shells (real surfaces land in E2/E3). We only assert
 * they respond OK, render their stable placeholder heading, and produce no
 * console errors — nothing about the eventual auth-gated behaviour.
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
});
