import { test, expect, type Page } from "@playwright/test";

/**
 * Regression guard for the nav "pages kept" counter at the zero baseline.
 *
 * `smoke.spec.ts` asserts the counter *reaches* 0 on mount. This spec asserts
 * it *stays* there: the engine used to fall back to a seeded `1284` when the
 * live count was falsy, then tick that figure upward on an ambient ~9s
 * interval — so a zero baseline silently became a growing, fabricated number.
 * A single read on mount cannot catch that; only dwelling past a tick can.
 *
 * It also checks the same figures under both colour schemes, since the counter
 * and the open-books number are written imperatively and could in principle be
 * skipped on one theme's render path.
 */

/** Label the nav counter must read while nothing has been kept yet. */
const ZERO_LABEL = "0 PAGES KEPT";

/** Ambient drift interval in the engine, plus margin for a second tick. */
const DRIFT_WINDOW_MS = 14_000;

/** How often to re-read the counter while dwelling. */
const SAMPLE_INTERVAL_MS = 2_000;

async function readCounter(page: Page): Promise<string> {
  return (
    await page
      .locator('[title="pages kept forever, right now"]')
      .evaluate((el) => el.textContent ?? "")
  )
    .replace(/\u00a0/g, " ")
    .trim();
}

test.describe("kept counter baseline", () => {
  // One long dwell; give it room rather than letting it race the default limit.
  test.slow();

  test("holds at zero across the ambient drift window", async ({ page }) => {
    await page.goto("/");

    // Settle first: the engine writes the count imperatively after mount.
    await expect
      .poll(async () => readCounter(page), { timeout: 10_000 })
      .toBe(ZERO_LABEL);

    // Deliberate dwell. There is no event to wait for here — the bug being
    // guarded against is the *absence* of a change over wall-clock time, so
    // sampling across a window longer than the engine's ~9s drift interval is
    // the only way to observe it. Every sample must still read zero.
    const samples: string[] = [];
    const deadline = Date.now() + DRIFT_WINDOW_MS;
    while (Date.now() < deadline) {
      await page.waitForTimeout(SAMPLE_INTERVAL_MS);
      samples.push(await readCounter(page));
    }

    expect(samples.length).toBeGreaterThanOrEqual(6);
    expect(
      samples,
      `counter drifted off zero: ${samples.join(" → ")}`,
    ).toEqual(samples.map(() => ZERO_LABEL));

    // The open-books number is fed from the same figure and must agree.
    await expect(page.locator("#gauge-card span").first()).toHaveText("0");
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`reports the zero baseline under the ${colorScheme} colour scheme`, async ({
      page,
    }) => {
      // Media-level emulation (not the `data-theme` attribute), so this covers
      // the theme the browser itself asks for on first paint.
      await page.emulateMedia({ colorScheme });
      await page.goto("/");

      await expect
        .poll(async () => readCounter(page), { timeout: 10_000 })
        .toBe(ZERO_LABEL);
      await expect(page.locator("#gauge-card span").first()).toHaveText("0");
      await expect(
        page.locator("#gauge").getByText("infra cost this month · €0.00"),
      ).toHaveCount(1);
      await expect(
        page.locator("#gauge").getByText("uptime · not yet measured"),
      ).toHaveCount(1);
    });
  }
});
