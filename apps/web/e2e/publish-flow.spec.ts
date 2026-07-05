import { test, expect } from "@playwright/test";

/**
 * Drop → mint → live phase flow, driven WITHOUT scrolling.
 *
 * Setting a file on the hidden `input[type=file]` fires the same onChange the
 * "browse" control does, which calls the engine's startMint(). The engine then
 * shows "Keeping it…" (minting) and after a ~1.7s timer flips to "live",
 * writing a real `<name>.kept.host` slug into the live label. We poll on the
 * slug pattern rather than exact copy so the test is resilient to slug names.
 */
const KEPT_HOST = /[a-z0-9-]+\.kept\.host/i;

test.describe("publish flow", () => {
  test("drop a file → minting → live slug (no scroll)", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const fileInput = page.locator('input[type="file"]');
    // Hidden input — Playwright can still set files on it directly.
    await expect(fileInput).toHaveCount(1);

    await fileInput.setInputFiles({
      name: "hello.html",
      mimeType: "text/html",
      buffer: Buffer.from(
        "<!doctype html><title>hi</title><h1>hello kept</h1>",
      ),
    });

    // Minting stage: the traveling tile shows "Keeping it…".
    await expect(page.getByText("Keeping it…")).toBeVisible({ timeout: 5_000 });

    // Live stage: after the mint timer, a freshly-minted `<slug>.kept.host` is
    // written into the live labels. The static placeholders present from first
    // paint ("page.kept.host", "yourpage.kept.host", "your-page.kept.host") are
    // filtered out, so a match here proves a real minted slug appeared.
    const PLACEHOLDERS = new Set([
      "page.kept.host",
      "yourpage.kept.host",
      "your-page.kept.host",
    ]);
    await expect
      .poll(
        async () => {
          const text = await page.evaluate(() => document.body.innerText || "");
          const all = text.match(/[a-z0-9-]+\.kept\.host/gi) ?? [];
          const minted = all.find((s) => !PLACEHOLDERS.has(s.toLowerCase()));
          return minted ?? "";
        },
        { timeout: 8_000, intervals: [200, 300, 500] },
      )
      .toMatch(KEPT_HOST);
  });
});
