import { expect, test } from "@playwright/test";

import {
  TRANSPARENT,
  gotoWithTokensApplied,
  trackConsoleErrors,
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
 * It also drills `gotoWithTokensApplied`'s one re-navigation: a sheet dropped
 * once is re-fetched without a trace in the console list, and a sheet dropped
 * on both loads still fails, naming it.
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

  test("the font tokens carry the design's faces: Hanken Grotesk, Geist, JetBrains Mono", async ({
    page,
  }) => {
    // E06 decision 1: display Hanken Grotesk, body Geist, mono JetBrains Mono,
    // bound through `--font-display` / `--font-body` / `--font-mono` and nowhere
    // else. next/font mangles family names (`__Hanken_Grotesk_1a2b3c`), so each
    // token is resolved on a probe element and compared with `_`/`-` read as
    // spaces.
    await gotoWithTokensApplied(page, ROUTE);

    const families = await page.evaluate(() => {
      const resolve = (token: string) => {
        const probe = document.createElement("span");
        probe.style.fontFamily = `var(${token})`;
        document.body.appendChild(probe);
        const family = getComputedStyle(probe).fontFamily;
        probe.remove();
        return family;
      };
      return {
        display: resolve("--font-display"),
        body: resolve("--font-body"),
        mono: resolve("--font-mono"),
      };
    });
    const words = (family: string) => family.replace(/[_-]+/g, " ").toLowerCase();

    expect(words(families.display)).toContain("hanken grotesk");
    expect(words(families.body)).toContain("geist");
    expect(words(families.mono)).toContain("jetbrains mono");
    // The faces they replaced are gone from every token: Geist is no longer the
    // display face, and Inter is not loaded at all.
    expect(words(families.display)).not.toContain("geist");
    expect(words(Object.values(families).join(","))).not.toMatch(/\binter\b/);

    // And the faces actually arrived — a family name with no file behind it
    // would pass the checks above and render in the fallback.
    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts]
        .filter((face) => face.status === "loaded")
        .map((face) => face.family.replace(/[_-]+/g, " ").toLowerCase());
    });
    expect(loaded.some((family) => family.includes("hanken grotesk"))).toBe(true);
    expect(loaded.some((family) => family.includes("geist"))).toBe(true);
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
  test("a stylesheet dropped once is re-fetched: the page lands and the console stays clean", async ({
    page,
  }) => {
    let drops = 0;
    await page.route("**/_next/static/css/**", (route) =>
      drops++ === 0 ? route.abort() : route.continue(),
    );
    const errors = trackConsoleErrors(page);

    const response = await gotoWithTokensApplied(page, ROUTE);
    expect(response?.ok()).toBe(true);
    expect(drops, "the first load's stylesheet was never dropped").toBeGreaterThan(1);
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
      ),
    ).not.toBe("");
    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("a stylesheet dropped on both loads still fails, naming it", async ({ page }) => {
    await page.route("**/_next/static/css/**", (route) => route.abort());

    const failure = await gotoWithTokensApplied(page, ROUTE, 2_000).then(
      () => null,
      (error: Error) => error.message,
    );
    expect(failure, "the guard passed a page whose stylesheet never arrived").not.toBeNull();
    expect(failure).toContain("on any of 2 loads");
    expect(failure).toContain(LAYOUT_CSS);
    expect(failure).toContain("NEVER DELIVERED");
  });
});
