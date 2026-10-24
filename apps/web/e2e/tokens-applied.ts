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
 * ── ONE RE-NAVIGATION, AND ONLY ON PROOF OF A DROP ────────────────────────
 *
 * `gotoWithTokensApplied` navigates by URL, so when the token layer is missing
 * AND the inventory shows a stylesheet that never arrived, it loads the same URL
 * once more. That is the whole retry: a page whose sheets all arrived but whose
 * tokens are still unset fails at once, and a sheet dropped twice fails, naming
 * it. CI's 1 worker + 1 test retry did not absorb the fault — the `dev-v0.9.0`
 * deploy lost two of its validate runs to it — so this answers it per
 * navigation instead. `waitForTokensApplied` alone never re-navigates: it runs
 * after clicks and form state that a reload would change.
 *
 * It relaxes no assertion — the same colours, the same theme differences and
 * the same empty console are still required afterwards. The one console line
 * it takes back is the `Failed to load resource` for the sheet it re-fetched,
 * and only from a `trackConsoleErrors` list; every other error stays. A parity
 * test that can pass because both themes are equally broken is worse than one
 * that fails.
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

function diagnose(url: string, waited: number, sheets: LinkedSheet[], loads = 1): string {
  const inventory = sheets.length
    ? sheets.map(describeSheet).join("\n")
    : "  (the document links no stylesheet at all)";

  return (
    `The design tokens never applied to ${url} within ${waited} ms` +
    (loads > 1 ? ` on any of ${loads} loads` : "") +
    `: \`${TOKEN_PROBE}\` is unset on :root.\n` +
    "Every computed colour on this page is therefore a browser default, and no " +
    "colour, radius or light/dark comparison here means anything — this is the " +
    "dev server dropping a static asset, NOT a token regression in the app.\n" +
    `Stylesheets linked by the document:\n${inventory}`
  );
}

const dropped = ({ rules }: LinkedSheet) => rules === null || rules === 0;

/** Whether the token layer lands on `page` within `timeout`. */
async function tokensApplied(page: Page, timeout: number): Promise<boolean> {
  return page
    .waitForFunction(
      (probe) =>
        getComputedStyle(document.documentElement).getPropertyValue(probe).trim() !== "",
      TOKEN_PROBE,
      { timeout },
    )
    .then(
      () => true,
      () => false,
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
  // Not swallowed — the timeout is re-thrown with the one thing it does not
  // say, which is WHICH stylesheet is missing.
  if (!(await tokensApplied(page, timeout))) {
    throw new Error(diagnose(page.url(), timeout, await linkedSheets(page)));
  }
}

/**
 * `page.goto`, but it does not return until the tokens are actually applied —
 * loading the URL a second time if the first load dropped a stylesheet.
 *
 * The response of the load that landed is passed straight through, so a caller
 * can still assert on the status the way `routes.spec.ts` does.
 */
export async function gotoWithTokensApplied(
  page: Page,
  url: string,
  timeout: number = TOKENS_APPLIED_TIMEOUT,
): Promise<Response | null> {
  const response = await page.goto(url);
  if (await tokensApplied(page, timeout)) return response;

  const lost = (await linkedSheets(page)).filter(dropped);
  if (lost.length === 0) {
    throw new Error(diagnose(page.url(), timeout, await linkedSheets(page)));
  }

  const retried = await page.goto(url);
  if (!(await tokensApplied(page, timeout))) {
    throw new Error(diagnose(page.url(), timeout, await linkedSheets(page), 2));
  }
  forgetDroppedSheetErrors(page, lost);
  return retried;
}

/** Each `trackConsoleErrors` list on a page, with the URL each entry came from. */
const consoleLists = new WeakMap<Page, { errors: string[]; sources: string[] }[]>();

/**
 * Collect the page's console errors and uncaught exceptions, for a test that
 * asserts there are none.
 *
 * The list is live: `gotoWithTokensApplied` removes from it the `Failed to load
 * resource` for a stylesheet it then re-fetched successfully, and nothing else.
 */
export function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  const sources: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    errors.push(msg.text());
    sources.push(msg.location().url);
  });
  page.on("pageerror", (err) => {
    errors.push(err.message);
    sources.push("");
  });
  consoleLists.set(page, [...(consoleLists.get(page) ?? []), { errors, sources }]);
  return errors;
}

function forgetDroppedSheetErrors(page: Page, lost: LinkedSheet[]): void {
  // Matched on pathname: the dev server stamps each load's `?v=` differently.
  const paths = new Set(lost.map(({ href }) => new URL(href, page.url()).pathname));
  for (const { errors, sources } of consoleLists.get(page) ?? []) {
    for (let i = errors.length - 1; i >= 0; i--) {
      const source = sources[i] ? new URL(sources[i] ?? "").pathname : "";
      if (paths.has(source) && errors[i]?.startsWith("Failed to load resource")) {
        errors.splice(i, 1);
        sources.splice(i, 1);
      }
    }
  }
}
