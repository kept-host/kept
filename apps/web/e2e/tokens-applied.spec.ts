import { expect, test } from "@playwright/test";

import {
  TRANSPARENT,
  gotoWithTokensApplied,
  waitForTokensApplied,
} from "./tokens-applied";

/**
 * The drill for the guard in `tokens-applied.ts`.
 *
 * A guard against an intermittent fault is worthless if nobody ever sees it
 * fire — it can rot into a no-op and the suite goes back to silently comparing
 * two browser defaults. So this reproduces the fault deterministically, by
 * aborting the stylesheet request the dev server intermittently drops on its
 * own, and asserts BOTH halves of the claim:
 *
 *   1. without the stylesheet, a token-painted card really does compute the
 *      same transparent default in light and in dark — i.e. the silent
 *      false-pass this guard exists to prevent is real, not theoretical;
 *   2. the guard refuses that page, and its message names the stylesheet.
 *
 * `/promise` is used because it is a static marketing route: no database, no
 * session, nothing that can make this drill skip.
 */
test.describe("the design-token readiness guard", () => {
  const ROUTE = "/promise";
  const LAYOUT_CSS = "/_next/static/css/app/layout.css";

  test("a healthy navigation lands with the token layer applied", async ({ page }) => {
    const response = await gotoWithTokensApplied(page, ROUTE);
    expect(response?.ok()).toBe(true);

    const token = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
    );
    expect(token).not.toBe("");
  });

  test("with the layout stylesheet dropped, the guard fails and names it", async ({
    page,
  }) => {
    // Exactly what `net::ERR_TOO_MANY_RETRIES` does to this request in the wild.
    await page.route("**/_next/static/css/**", (route) => route.abort());
    await page.goto(ROUTE);

    // The document itself is fine — which is precisely why this fault is
    // mistaken for a product bug.
    await expect(
      page.getByRole("heading", { name: "If kept ever winds down" }),
    ).toBeVisible();

    // The false pass this guard prevents: both themes read the same default, so
    // an `expect(dark).not.toBe(light)` parity check would compare equal.
    const surface = () =>
      page
        .locator("body")
        .evaluate((el) => getComputedStyle(el).backgroundColor);
    const light = await surface();
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    const dark = await surface();
    expect(light).toBe(TRANSPARENT);
    expect(dark).toBe(light);

    // And the guard refuses to let a test reach that comparison.
    const failure = await waitForTokensApplied(page, 2_000).then(
      () => null,
      (error: Error) => error.message,
    );
    expect(failure, "the guard did not fire on a page with no stylesheet").not.toBeNull();
    expect(failure).toContain(LAYOUT_CSS);
    expect(failure).toContain("NEVER DELIVERED");
    expect(failure).toContain("--bg");
  });
});
