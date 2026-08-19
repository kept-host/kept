import type { Page, Response } from "@playwright/test";

/**
 * The precondition every computed-style assertion in this suite depends on, and
 * which none of them used to establish.
 *
 * Not a `*.spec.ts`, so Playwright never collects it as a test file. Its own
 * drill — including the failure path — is `tokens-applied.spec.ts`.
 *
 * ── AN INFRASTRUCTURE FAULT THAT READS EXACTLY LIKE A TOKEN REGRESSION ─────
 *
 * The local harness runs `next dev --experimental-https`, and that server
 * intermittently drops a static asset: measured directly, the document loads
 * 200 while `/_next/static/css/app/layout.css` fails with
 * `net::ERR_TOO_MANY_RETRIES`. The page still renders, every element still
 * carries its `bg-surface` / `bg-accent` class — and every computed colour is a
 * browser default. So:
 *
 *   - a colour assertion sees `rgba(0, 0, 0, 0)` and reports a token that was
 *     never removed (`gauge-dock.spec.ts` → `firstDotBg`);
 *   - a light/dark parity assertion reads the SAME default in both themes, the
 *     two compare EQUAL, and it reports a hardcoded colour that does not exist
 *     (`anon-keep-flow.spec.ts`, `auth-screen.spec.ts`);
 *   - a no-console-errors assertion sees `Failed to load resource`
 *     (`routes.spec.ts` → /stats and /promise, `smoke.spec.ts`).
 *
 * This has cost this project real time in four separate runs and sent two
 * investigations after product bugs that do not exist.
 *
 * ── WHY THE PROBE IS A DESIGN TOKEN AND NOT A COLOUR OR A `<link>` ─────────
 *
 * Three candidate signals; only one of them actually says what we need:
 *
 *   1. **The `<link rel="stylesheet">` element exists.** Worthless. The element
 *      is in the served HTML whether or not the bytes ever arrived.
 *   2. **`link.sheet !== null` / `document.styleSheets` contains it.** Measured,
 *      and on its own it is a LIE: with the request aborted outright, Chromium
 *      still hands the link an ATTACHED `CSSStyleSheet`, so a null-check
 *      reports "loaded" for a stylesheet that never arrived. (What does
 *      distinguish them is that the attached sheet is not origin-clean, so
 *      reading `cssRules` throws.) And it stays delivery-shaped either way,
 *      because Next's dev server can also deliver the same CSS through an
 *      injected `<style>` on an HMR pass, which a link-only check would call
 *      "missing".
 *   3. **A `:root` custom property resolves.** `--bg` is declared in exactly one
 *      place, `app/globals.css`, which reaches the browser only inside the
 *      layout stylesheet. If style resolution can see it, the token layer is
 *      applied; if it cannot, `getPropertyValue` returns `""`. That is the
 *      precondition itself rather than a proxy for it, it is indifferent to how
 *      the CSS was delivered, and — because it asserts only "not empty" — it
 *      hardcodes no colour, which the repo forbids.
 *
 * So (3) is the gate and (2) is the *diagnostic*: on failure we name the
 * stylesheets the document asked for and say which of them never parsed.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
 *
 * It does not re-navigate, retry, or sleep a fixed amount, and it relaxes no
 * assertion — the same colours, the same theme differences and the same empty
 * console are still required afterwards. When the asset genuinely never
 * arrives the run FAILS, naming the stylesheet, instead of silently comparing
 * two defaults. A parity test that can pass because both themes are equally
 * broken is worse than one that fails.
 */

/** What an element with no painted background reports. */
export const TRANSPARENT = "rgba(0, 0, 0, 0)";

/**
 * The `:root` custom property that stands in for the whole token layer.
 *
 * `--bg` is the first declaration in `app/globals.css` and is redeclared by the
 * `[data-theme="dark"]` block, so it exists in both themes and on every route
 * that renders through `app/layout.tsx`.
 */
const TOKEN_PROBE = "--bg";

/**
 * How long the token layer is allowed to take to land.
 *
 * Generous on purpose: the suite drives a dev server that compiles CSS on
 * demand, so a cold first navigation legitimately waits seconds. It is a
 * ceiling on a *readiness* wait, not a budget added to an assertion — when the
 * asset is coming, the poll returns as soon as it lands.
 */
export const TOKENS_APPLIED_TIMEOUT = 15_000;

/** `rules` is null when the sheet is attached but opaque — see `linkedSheets`. */
type LinkedSheet = { href: string; rules: number | null };

/** Which stylesheets the document asked for, and how much CSS each one carries. */
async function linkedSheets(page: Page): Promise<LinkedSheet[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((link) => {
      const href = link.getAttribute("href") ?? "(no href)";
      if (!link.sheet) return { href, rules: 0 };
      try {
        return { href, rules: link.sheet.cssRules.length };
      } catch {
        // Measured: a request that failed still leaves an ATTACHED sheet, but
        // one that is not origin-clean, so reading `cssRules` throws. The throw
        // is the signal — not swallowed, reported.
        return { href, rules: null };
      }
    }),
  );
}

function describeSheet({ href, rules }: LinkedSheet): string {
  if (rules === null) {
    return `  - ${href} — NEVER DELIVERED (attached but opaque: the load failed)`;
  }
  if (rules === 0) return `  - ${href} — NEVER DELIVERED (attached but empty: 0 rules)`;
  return `  - ${href} — delivered (${rules} rules)`;
}

function diagnose(url: string, waited: number, sheets: LinkedSheet[]): string {
  const inventory = sheets.length
    ? sheets.map(describeSheet).join("\n")
    : "  (the document links no stylesheet at all)";

  return (
    `The design tokens never applied to ${url} within ${waited} ms: ` +
    `\`${TOKEN_PROBE}\` is unset on :root.\n` +
    "Every computed colour on this page is therefore a browser default, and no " +
    "colour, radius or light/dark comparison here means anything — this is the " +
    "dev server dropping a static asset, NOT a token regression in the app.\n" +
    `Stylesheets linked by the document:\n${inventory}`
  );
}

/**
 * Block until the token layer is applied to `page`, or fail naming the
 * stylesheet that never arrived.
 *
 * Call this after any navigation whose test then reads a computed style.
 */
export async function waitForTokensApplied(
  page: Page,
  timeout: number = TOKENS_APPLIED_TIMEOUT,
): Promise<void> {
  try {
    await page.waitForFunction(
      (probe) =>
        getComputedStyle(document.documentElement).getPropertyValue(probe).trim() !== "",
      TOKEN_PROBE,
      { timeout },
    );
  } catch {
    // Not swallowed — re-thrown with the one thing the raw timeout does not
    // say, which is WHICH stylesheet is missing.
    throw new Error(diagnose(page.url(), timeout, await linkedSheets(page)));
  }
}

/**
 * `page.goto`, but it does not return until the tokens are actually applied.
 *
 * The response is passed straight through, so a caller can still assert on the
 * status the way `routes.spec.ts` does.
 */
export async function gotoWithTokensApplied(
  page: Page,
  url: string,
  timeout: number = TOKENS_APPLIED_TIMEOUT,
): Promise<Response | null> {
  const response = await page.goto(url);
  await waitForTokensApplied(page, timeout);
  return response;
}
