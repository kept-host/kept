import { test, expect } from "@playwright/test";

/**
 * Landing content contract, section by section.
 *
 * `smoke.spec.ts` covers page structure and the headline zero-baseline claims;
 * this spec goes one level deeper into the copy each section is required to
 * carry after the drafts/kept pivot — the hero's agent path, the four
 * how-it-works steps, the keyless For-Agents contract, the pricing checklists,
 * and the negative assertions that keep donation-era vocabulary out of the
 * rendered markup (not just the visible text).
 *
 * Nothing here scrolls: every section is in the DOM from first paint, so the
 * assertions run on `toHaveCount` / text content rather than visibility, which
 * the scroll-choreography engine would otherwise make flaky headless.
 */

/**
 * The one line a human pastes into their agent — same literal `smoke.spec.ts`
 * asserts, kept in sync deliberately so a drift breaks both specs at once.
 */
const AGENT_PROMPT =
  "Publish this HTML with kept (https://kept.host/agents): call the MCP tool `publish_page`, then give me the live link and the claim link.";

/**
 * Free-tier checklist, in the order the Free card must render it. The kept
 * allowance carries no number — "dozens" — until the limit is decided
 * (E06a §7, D-13 open).
 */
const FREE_CHECKLIST = [
  "Unlimited drafts — live instantly, 7 days",
  "Dozens of pages kept forever",
  "Instant link, QR, live status",
  "Keep, rename slug, replace versions",
  "Dashboard for pages & drafts",
];

/**
 * Every phrase the community-funding era used. None may survive anywhere in the
 * served markup — including collapsed accordion bodies and element attributes,
 * which is why this runs against `page.content()` rather than `innerText`.
 */
const FUNDING_VOCABULARY = [
  /Open Collective/i,
  /donat/i,
  /funded by/i,
  /community is keeping/i,
  /runway/i,
  /supporter/i,
  /\/\s*2,?000/,
  /1,284/,
];

test.describe("landing content", () => {
  test("hero offers the agent path and how-it-works names its four steps in order", async ({
    page,
  }) => {
    await page.goto("/");

    // The hero's secondary path hands the job to an agent and jumps to the
    // For-Agents section rather than to a signup.
    const agentLink = page.getByRole("link", {
      name: /or let your agent do it/,
    });
    await expect(agentLink).toHaveCount(1);
    await expect(agentLink).toHaveAttribute("href", "#agents");

    // Four steps, in order. "Keep" (step 03) is the pivot's verb — the old
    // "Claim" framing is gone, and step 04 is what "kept" then means.
    await expect(page.locator("#how h3")).toHaveText([
      "Drop",
      "Get a link",
      "Keep",
      "Kept forever",
    ]);

    // The two steps that carry the free-tier numbers state them explicitly.
    await expect(page.locator('#how [data-step="1"] p')).toContainText(
      "7 days",
    );
    await expect(page.locator('#how [data-step="2"] p')).toContainText(
      "dozens of",
    );
  });

  test("For-Agents publishes keylessly and states the publish_page contract", async ({
    page,
  }) => {
    await page.goto("/");
    const agents = page.locator("#agents");

    // Intro copy: the promise is zero setup, no key, no account.
    await expect(
      agents.getByText(/AI agents generate HTML all day\. Give it a home\./),
    ).toHaveCount(1);
    await expect(
      agents.getByText(/publishes with zero setup .* no key, no account/),
    ).toHaveCount(1);

    // The MCP config snippet is keyless: a bare npx command with no token and
    // no `env` block to put one in.
    const mcpConfig = agents.locator("pre").filter({ hasText: "@kept/mcp" });
    await expect(mcpConfig).toHaveCount(1);
    const mcpConfigText = (await mcpConfig.textContent()) ?? "";
    expect(mcpConfigText).toContain('"npx"');
    expect(mcpConfigText).not.toMatch(/KEPT_TOKEN/);
    expect(mcpConfigText).not.toMatch(/\benv\b/);
    expect(mcpConfigText).not.toMatch(/token|api[_-]?key/i);

    // The tool contract an agent gets back, spelled out.
    await expect(
      agents.locator("code").filter({ hasText: "kept.publish_page(html)" }),
    ).toHaveCount(1);
    await expect(
      agents
        .locator("code")
        .filter({ hasText: '{ live_url, claim_url, expires_in: "7d" }' }),
    ).toHaveCount(1);

    // No Pro feature but the wall editor (E06a §7): the API-key power path is
    // gone, and API keys are never a prerequisite for the free keyless flow.
    const agentsText = await agents.evaluate(
      (el) => (el as HTMLElement).innerText,
    );
    expect(agentsText).not.toMatch(/API keys|Pro\b/);

    // No SOON / COMING SOON pills (E06a §7): the hero's framing line carries
    // the date on a closed deploy instead.
    expect(agentsText).not.toMatch(/\bSOON\b/);

    // "Get notified" is a waitlist door, not a dead regex-only form.
    await expect(agents.locator('input[type="email"]')).toHaveCount(0);
    await expect(
      agents.getByRole("button", { name: "Get notified" }),
    ).toHaveCount(1);
  });

  test("the copy control is keyboard-operable and copies the exact prompt", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");

    const copy = page.getByRole("button", {
      name: "Copy the agent prompt to your clipboard",
    });
    await expect(copy).toHaveAccessibleName(
      "Copy the agent prompt to your clipboard",
    );

    // Keyboard path: the control takes focus and activates on Enter, so the
    // prompt is reachable without a pointer (the intro loader overlay would
    // otherwise intercept clicks).
    await copy.focus();
    await expect(copy).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(copy).toHaveText("COPIED");
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(AGENT_PROMPT);
  });

  test("pricing states the free checklist in order and the founding card", async ({
    page,
  }) => {
    await page.goto("/");
    const pricing = page.locator("#pricing");

    // The Free card is badged as permanent, not as a trial.
    await expect(pricing.getByText("FREE FOREVER")).toHaveCount(1);

    // Every checklist row renders, and in the documented order — the two
    // load-bearing limits (drafts, kept pages) lead.
    const pricingText = await pricing.evaluate(
      (el) => (el as HTMLElement).innerText,
    );
    const positions = FREE_CHECKLIST.map((row) => {
      expect(pricingText, `missing free-tier row: ${row}`).toContain(row);
      return pricingText.indexOf(row);
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    // The Pro card is the founding card (E06a §7, PRD §4 facts only): the wall
    // editor is the one Pro feature named, and there is no price.
    await expect(
      pricing.getByRole("heading", { name: "Become a founding creator" }),
    ).toHaveCount(1);
    await expect(pricing.getByText(/including the wall editor/)).toHaveCount(1);
    await expect(
      pricing.getByRole("link", { name: /Apply to be a founding creator/ }),
    ).toHaveAttribute("href", "/founding");
    expect(pricingText).not.toMatch(/€|\$\d|per month|\/mo\b/i);
    expect(pricingText).not.toMatch(
      /EU data residency|Custom domains|API keys|Password-protected|Notify me about Pro/,
    );
  });

  test("free-tier limits are stated consistently across how-it-works, trust trio, and pricing", async ({
    page,
  }) => {
    await page.goto("/");

    // Wherever a section quotes the draft window it must quote the shared
    // constant (7 days); the kept-page allowance carries no number at all
    // (E06a §7, D-13 open).
    for (const id of ["#how", "#why", "#pricing"]) {
      const text = await page
        .locator(id)
        .evaluate((el) => (el as HTMLElement).innerText);

      const dayFigures = [...text.matchAll(/(\d+)\s+days?\b/g)].map(
        (m) => m[1],
      );
      expect(dayFigures.length, `${id} states no draft window`).toBeGreaterThan(
        0,
      );
      expect(new Set(dayFigures), `${id} day figures`).toEqual(new Set(["7"]));

      expect(text, `${id} states a kept-page number`).not.toMatch(
        /\d+\s+pages?\b/,
      );
    }

    // #how and #pricing both still speak to the kept allowance, in words.
    for (const id of ["#how", "#pricing"]) {
      const text = await page
        .locator(id)
        .evaluate((el) => (el as HTMLElement).innerText);
      expect(text, `${id} omits the kept-page allowance`).toMatch(
        /dozens of\s+pages/i,
      );
    }
  });

  test("no funding-era vocabulary survives anywhere in the served markup", async ({
    page,
  }) => {
    await page.goto("/");

    // `innerText` skips collapsed accordion bodies and attribute text; the full
    // serialized document does not, so this is the strict version of the
    // vocabulary sweep.
    const html = await page.content();
    for (const pattern of FUNDING_VOCABULARY) {
      expect(html, `funding-era vocabulary still present: ${pattern}`).not.toMatch(
        pattern,
      );
    }

    // The footer in particular carries no funding ask and no dead links —
    // every label without a route renders as plain text.
    const footer = page.locator("footer");
    const footerText = await footer.evaluate(
      (el) => (el as HTMLElement).innerText,
    );
    expect(footerText).not.toMatch(/Open Collective|donat|sponsor|back us/i);
    await expect(
      footer.locator("a[href='']"),
    ).toHaveCount(0);
  });

  test("AC29: the footer links to the acceptable-use rules and the report form, and both serve", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    const footer = page.locator("footer");
    for (const [label, href] of [
      ["Acceptable use", "/legal/acceptable-use"],
      ["Report a page", "/report"],
    ] as const) {
      // "Acceptable use" also sits in the footer's LegalLinks row, which on a
      // single-origin deploy carries the same relative href — so at least one.
      const count = await footer.locator(`a[href='${href}']`, { hasText: label }).count();
      console.log(`[landing] footer "${label}" → ${href}: ${count}`);
      expect(count).toBeGreaterThan(0);
      const res = await request.get(href, { maxRedirects: 0 });
      console.log(`[landing] GET ${href} → ${res.status()}`);
      expect(res.status()).toBe(200);
    }
  });
});
