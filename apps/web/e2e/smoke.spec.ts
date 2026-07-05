import { test, expect } from "@playwright/test";

/**
 * Smoke test for the landing page ("/").
 *
 * Asserts document structure, the procedural hero wall, the fixed drop-tile,
 * all section anchors, and nav links — nothing scroll-driven (the choreography
 * engine throttles headless, so poses / reveal opacity are intentionally out of
 * scope here). Console errors are treated as hard failures (zero tolerance).
 */
test.describe("landing smoke", () => {
  test("renders structure, procedural wall, and drop-tile with no console errors", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(err.message));

    await page.goto("/");
    await expect(page).toHaveTitle("kept");

    // Scroll root exists.
    await expect(page.locator("#kept-root")).toBeVisible();

    // The hero wall paints procedural thumbnails as data URIs. The engine paints
    // 63 tiles imperatively on mount; poll until at least 24 have a data src.
    await expect
      .poll(
        async () =>
          page
            .locator('#wall img[data-thumb]')
            .evaluateAll(
              (imgs) =>
                imgs.filter((im) =>
                  (im as HTMLImageElement).src.startsWith("data:image"),
                ).length,
            ),
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(24);

    // The fixed traveling drop-tile exists, is position:fixed, and reads
    // "Drop your HTML". (The same copy also lives in a conditionally-rendered
    // accordion; asserting on the fixed ancestor disambiguates.)
    await expect(page.getByText("Drop your HTML").first()).toBeVisible();
    const hasFixedDropTile = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("div"));
      return els.some(
        (el) =>
          getComputedStyle(el).position === "fixed" &&
          (el.textContent ?? "").includes("Drop your HTML"),
      );
    });
    expect(hasFixedDropTile).toBe(true);

    // All section anchors present in the DOM.
    for (const id of ["#how", "#agents", "#gauge", "#why", "#pricing"]) {
      await expect(page.locator(id)).toHaveCount(1);
    }
    await expect(page.locator("footer")).toHaveCount(1);

    // Nav links render (real labels: ABOUT / OPEN SOURCE / FOR AGENTS / PRICING).
    const nav = page.locator("#nav-links");
    await expect(nav.getByText("ABOUT")).toBeVisible();
    await expect(nav.getByText(/OPEN\s*SOURCE/)).toBeVisible();
    await expect(nav.getByText(/FOR\s*AGENTS/)).toBeVisible();
    await expect(nav.getByText("PRICING")).toBeVisible();

    expect(consoleErrors, `console errors: ${consoleErrors.join(" | ")}`).toEqual(
      [],
    );
  });
});
