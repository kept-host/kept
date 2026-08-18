import { test, expect } from "@playwright/test";

/**
 * Smoke + content contract for the landing page ("/").
 *
 * Asserts document structure, the procedural hero wall, the fixed drop-tile,
 * the section anchors and nav links, and the load-bearing claims of the
 * drafts/kept pivot — nothing scroll-driven (the choreography engine throttles
 * headless, so poses / reveal opacity are intentionally out of scope here).
 * Console errors are treated as hard failures (zero tolerance).
 */

/**
 * The one line a human pastes into their agent. Asserted as a literal so the
 * rendered prompt and the clipboard payload can never drift unnoticed.
 */
const AGENT_PROMPT =
  "Publish this HTML with kept (https://kept.host/agents): call the MCP tool `publish_page`, then give me the live link and the claim link.";

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

    // The landing has a way in to an account at all. It points at /dashboard,
    // never /auth: signed in that IS the destination; signed out the `(app)`
    // gate bounces to /auth?next=%2Fdashboard and returns there afterwards. It
    // also cannot be session-aware — the session cookie is host-only to `app.`
    // and is never sent to this apex — so the label is unconditional.
    const signIn = page.locator("#nav-signin");
    await expect(signIn).toBeVisible();
    await expect(signIn).toHaveText(/SIGN\s*IN/);
    const signInHref = await signIn.evaluate(
      (el) => (el as HTMLAnchorElement).href,
    );
    expect(new URL(signInHref).pathname).toBe("/dashboard");

    expect(consoleErrors, `console errors: ${consoleErrors.join(" | ")}`).toEqual(
      [],
    );
  });

  test("reports the real zero baseline — no seeded count, funding target, or unearned uptime", async ({
    page,
  }) => {
    await page.goto("/");

    // Nav counter: the engine writes the kept count imperatively on mount. At
    // the launch baseline that is a literal 0 under the "PAGES KEPT" label —
    // never a seeded figure, and it must not drift off zero on its own.
    const counter = page.locator('[title="pages kept forever, right now"]');
    await expect
      .poll(
        async () =>
          (await counter.evaluate((el) => el.textContent ?? ""))
            .replace(/\u00a0/g, " ")
            .trim(),
        { timeout: 10_000 },
      )
      .toBe("0 PAGES KEPT");

    // Open-books panel: real figures, and "not yet measured" rather than an
    // unearned 100% uptime. The big number is the first span in the card.
    const gauge = page.locator("#gauge");
    await expect(gauge.getByText("Open books")).toHaveCount(1);
    await expect(gauge.getByText("infra cost this month · €0.00")).toHaveCount(
      1,
    );
    await expect(gauge.getByText("uptime · not yet measured")).toHaveCount(1);
    await expect(gauge.locator("#gauge-card span").first()).toHaveText("0");

    // No donation-era figure survives anywhere in the rendered page: the
    // "/ 2,000" funded-pages target and the seeded 1,284 counter are both gone.
    const bodyText = await page.evaluate(() => document.body.innerText ?? "");
    expect(bodyText).not.toMatch(/2,?000/);
    expect(bodyText).not.toMatch(/1,?284/);
    expect(bodyText).not.toMatch(/Open Collective/i);
    expect(bodyText).not.toMatch(/donat/i);
    expect(bodyText).not.toMatch(/supporter/i);
    expect(bodyText).not.toMatch(/runway/i);
  });

  test("states the drafts/kept model and links out to the open books", async ({
    page,
  }) => {
    await page.goto("/");

    // How-it-works step 04 describes what "kept" means. It must NOT claim
    // permanence from the moment the page mints — a page mints as a draft.
    const how = page.locator("#how");
    await expect(how.getByText("Kept forever")).toHaveCount(1);
    await expect(
      how.getByText(
        "Once kept, there’s no expiry and no rot. Nothing to renew, no login needed to keep it up, and we never delete it quietly.",
      ),
    ).toHaveCount(1);
    await expect(how.getByText(/Permanent by default/)).toHaveCount(0);
    // Step 02 keeps the draft clock honest; step 03 is "Keep", not "Claim".
    await expect(how.getByText(/a draft, live for 7 days/)).toHaveCount(1);
    await expect(how.getByText("Keep", { exact: true })).toHaveCount(1);
    await expect(how.getByText(/Claim/)).toHaveCount(0);

    // The stats CTA on the open-books panel points at the real route.
    await expect(
      page.getByRole("link", { name: /See the math/ }),
    ).toHaveAttribute("href", "/stats");

    // The trust trio no longer repeats the panel's own "Open books" kicker.
    const why = page.locator("#why");
    await expect(why.getByText("COSTS IN PUBLIC")).toHaveCount(1);
    await expect(why.getByText("OPEN BOOKS")).toHaveCount(0);

    // Free tier: unlimited 7-day drafts + 3 kept forever, stated in pricing.
    const pricing = page.locator("#pricing");
    await expect(
      pricing.getByText("Unlimited drafts — live instantly, 7 days"),
    ).toHaveCount(1);
    await expect(pricing.getByText("3 pages kept forever")).toHaveCount(1);
    await expect(
      pricing.getByText("Keep, rename slug, replace versions"),
    ).toHaveCount(1);
    // Pro rows render as `<b>{title}</b> — {body}`; assert the joined string.
    await expect(
      pricing.getByText("API keys — agents publish straight to your account."),
    ).toHaveCount(1);
    await expect(
      pricing.getByText(
        "More pages kept forever — keep well beyond the free 3.",
      ),
    ).toHaveCount(1);
  });

  test("footer links only where a route exists, and both destinations resolve", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    const footer = page.locator("footer");

    // Labels without a destination render as <span>, never a dead <a>. Exactly
    // two footer anchors exist today: Stats and The forever promise.
    await expect(footer.locator("a")).toHaveCount(2);
    await expect(footer.getByRole("link", { name: "Stats" })).toHaveAttribute(
      "href",
      "/stats",
    );
    await expect(
      footer.getByRole("link", { name: "The forever promise" }),
    ).toHaveAttribute("href", "/promise");

    // Destination-less labels are still rendered, as plain text.
    await expect(footer.getByText("GitHub repo")).toHaveCount(1);
    await expect(footer.getByText("License · AGPL-3.0")).toHaveCount(1);

    // The two real routes actually serve.
    expect((await request.get("/stats")).status()).toBe(200);
    expect((await request.get("/promise")).status()).toBe(200);
  });

  test("reduced motion and the dark theme report the same zero baseline", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(err.message));

    // Under reduced motion the engine skips the count-up and writes both the
    // nav counter and the gauge number directly — the same figures, no
    // animation and no seeded fallback.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");

    const counter = page.locator('[title="pages kept forever, right now"]');
    await expect
      .poll(
        async () =>
          (await counter.evaluate((el) => el.textContent ?? ""))
            .replace(/\u00a0/g, " ")
            .trim(),
        { timeout: 10_000 },
      )
      .toBe("0 PAGES KEPT");
    await expect
      .poll(async () =>
        page.locator("#gauge-card span").first().textContent(),
      )
      .toBe("0");
    await expect(
      page.locator("#gauge").getByText("uptime · not yet measured"),
    ).toHaveCount(1);

    // Same content in the dark theme (next-themes drives `data-theme`).
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    await expect(page.locator('html[data-theme="dark"]')).toHaveCount(1);
    await expect(
      page.locator("#pricing").getByText("3 pages kept forever"),
    ).toHaveCount(1);
    await expect(
      page.locator("#why").getByText("COSTS IN PUBLIC"),
    ).toHaveCount(1);
    await expect(
      page.locator("#gauge").getByText("uptime · not yet measured"),
    ).toHaveCount(1);

    expect(consoleErrors, `console errors: ${consoleErrors.join(" | ")}`).toEqual(
      [],
    );
  });

  test("the For-Agents copy button puts the exact prompt on the clipboard", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");

    // The rendered prompt and the clipboard payload share one source string.
    await expect(page.getByText(AGENT_PROMPT)).toHaveCount(1);

    const copy = page.getByRole("button", {
      name: "Copy the agent prompt to your clipboard",
    });
    await expect(copy).toHaveText("COPY");
    // The intro loader covers the page for ~2s; Playwright's actionability
    // check retries the click until it stops intercepting pointer events.
    await copy.click();

    // Copied-state affordance: the button label and the polite live region.
    await expect(copy).toHaveText("COPIED");
    await expect(page.getByText("Copied to clipboard")).toHaveCount(1);

    // Real clipboard read — no stub, no mock.
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(AGENT_PROMPT);

    // The affordance reverts on its own, so the button stays reusable.
    await expect(copy).toHaveText("COPY", { timeout: 5_000 });
  });
});
