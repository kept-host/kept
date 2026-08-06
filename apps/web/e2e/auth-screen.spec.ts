import { test, expect, type Page } from "@playwright/test";

/**
 * `/auth` — the sign-in screen. E05 task 005.
 *
 * ── WHAT THIS SUITE CAN AND CANNOT PROVE ───────────────────────────────────
 * `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` do not exist yet (the Google
 * Cloud OAuth app is unprovisioned — see the epic's Unresolved Inputs), so the
 * Better Auth instance cannot be constructed and every `/api/auth/*` endpoint
 * answers 500. That is not a limitation to work around here — it is the exact
 * production incident the screen is designed to survive, and it makes three
 * things provable against the real app with no mocking whatsoever:
 *
 *   1. `/auth` still renders all three routes when the auth layer is down. The
 *      shell has no session dependency, which is the whole reason the session
 *      is read in the browser rather than in the server component.
 *   2. Both failure paths reach a readable error panel with a working button,
 *      not a spinner. The 500 is a real 500 from the real handler.
 *   3. The `next` return URL is threaded into the real request body and is
 *      validated by `safeReturnPath` on the way in.
 *
 * WHAT IT CANNOT PROVE: the **sent** state and its resend cooldown, which need
 * `/api/auth/sign-in/magic-link` to answer 200 — i.e. the Google credentials
 * plus a verified Resend sending domain. Faking that response would mean
 * mocking the auth layer, which the project forbids outright, so it is left to
 * task 012 against the dev stack.
 *
 * NO `page.route(..., fulfill)` ANYWHERE. The one place this suite touches the
 * network (`slowRequest`) delays a request and then continues it — the response
 * still comes from the real handler. Delaying is throttling; substituting would
 * be a mock.
 */

const SIGN_IN_HEADING = "Sign in to kept";

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

/**
 * Hold a request open long enough to observe the loading state, then let it go
 * to the real server. Returns a promise that resolves once it has been held.
 */
async function slowRequest(page: Page, urlPart: string, ms: number) {
  await page.route(
    (url) => url.pathname.includes(urlPart),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      await route.continue();
    },
  );
}

test.describe("/auth sign-in screen", () => {
  test("idle offers three routes in the imported order, with the placeholder gone", async ({
    page,
  }) => {
    const res = await page.goto("/auth");
    expect(res?.ok()).toBe(true);

    await expect(page).toHaveTitle("Sign in · kept");
    await expect(page.getByRole("heading", { name: SIGN_IN_HEADING })).toBeVisible();

    // The stale E00 placeholder and its wrong-epic sentence are gone.
    await expect(page.getByText("wired in E2")).toHaveCount(0);
    await expect(page.getByText("Sign-in placeholder")).toHaveCount(0);

    // GitHub · Google · divider · email, in that vertical order. Both provider
    // buttons are the same component — asserted structurally by the shared
    // `data-provider` hook rather than by two bespoke selectors.
    const providers = page.locator("button[data-provider]");
    await expect(providers).toHaveCount(2);
    await expect(providers.nth(0)).toHaveAttribute("data-provider", "github");
    await expect(providers.nth(1)).toHaveAttribute("data-provider", "google");
    await expect(providers.nth(0)).toHaveText("Continue with GitHub");
    await expect(providers.nth(1)).toHaveText("Continue with Google");

    // Google's mark is an inline four-colour SVG asset, not a recoloured glyph.
    await expect(providers.nth(1).locator('svg path[fill="#4285F4"]')).toHaveCount(1);

    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Email me a magic link" }),
    ).toBeVisible();

    // Keep vocabulary, never "claim".
    await expect(page.getByText(/keep them forever/)).toBeVisible();
    await expect(page.getByText(/claim/i)).toHaveCount(0);

    // The provider buttons sit above the divider, which sits above the field.
    const githubBox = await providers.nth(0).boundingBox();
    const googleBox = await providers.nth(1).boundingBox();
    const emailBox = await page.getByLabel("Email").boundingBox();
    expect(githubBox!.y).toBeLessThan(googleBox!.y);
    expect(googleBox!.y).toBeLessThan(emailBox!.y);
  });

  test("renders with all three routes even though the auth API is down", async ({
    page,
  }) => {
    // Proof, not assumption: the endpoint the session read uses is failing.
    const session = await page.request.get("/api/auth/get-session");
    expect(session.status()).toBe(500);

    const res = await page.goto("/auth");
    expect(res?.ok()).toBe(true);
    await expect(page.getByRole("heading", { name: SIGN_IN_HEADING })).toBeVisible();
    await expect(page.locator("button[data-provider]")).toHaveCount(2);
  });

  test("an OAuth click shows the redirect state, then a readable error — never a silent spinner", async ({
    page,
  }) => {
    await slowRequest(page, "/sign-in/social", 700);
    await page.goto("/auth");

    await page.getByRole("button", { name: "Continue with GitHub" }).click();

    // The loading state names the provider and is distinct from the magic-link
    // one, and it carries an escape hatch because a full-page redirect out of
    // our control might never arrive.
    await expect(
      page.getByRole("heading", { name: "Redirecting to GitHub…" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "cancel" })).toBeVisible();

    // …and it terminates. The 500 becomes words plus a button.
    await expect(
      page.getByRole("heading", { name: "We could not reach that provider" }),
    ).toBeVisible({ timeout: 15_000 });
    // Announced, not just drawn. (Next mounts its own route-announcer with
    // role="alert", hence the filter to the panel that carries the copy.)
    await expect(
      page.getByRole("alert").filter({ hasText: "We could not reach that provider" }),
    ).toBeVisible();

    const retry = page.getByRole("button", { name: "Try again" });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(page.getByRole("heading", { name: SIGN_IN_HEADING })).toBeVisible();
  });

  test("a magic-link submit shows its own loading copy, then the send failure", async ({
    page,
  }) => {
    await slowRequest(page, "/sign-in/magic-link", 700);
    await page.goto("/auth");

    await page.getByLabel("Email").fill("someone@example.com");
    await page.getByRole("button", { name: "Email me a magic link" }).click();

    await expect(
      page.getByRole("heading", { name: "Sending your link…" }),
    ).toBeVisible();

    // Task 003's `sendMagicLink` rejects rather than swallowing a Resend
    // failure precisely so it surfaces here.
    await expect(
      page.getByRole("heading", { name: "We could not send that email" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("the next return URL rides the real request, and an unsafe one is dropped", async ({
    page,
  }) => {
    await page.goto("/auth?next=%2Fdashboard%3Ftab%3Ddrafts");
    const safe = page.waitForRequest(
      (req) => req.url().includes("/sign-in/magic-link") && req.method() === "POST",
    );
    await page.getByLabel("Email").fill("someone@example.com");
    await page.getByRole("button", { name: "Email me a magic link" }).click();
    expect(JSON.parse((await safe).postData() ?? "{}").callbackURL).toBe(
      "/dashboard?tab=drafts",
    );

    // The open-redirect guard: an absolute URL in `next` collapses to APP_HOME
    // rather than becoming somewhere to send a freshly signed-in user.
    await page.goto("/auth?next=https%3A%2F%2Fevil.example%2Flogin");
    const guarded = page.waitForRequest(
      (req) => req.url().includes("/sign-in/magic-link") && req.method() === "POST",
    );
    await page.getByLabel("Email").fill("someone@example.com");
    await page.getByRole("button", { name: "Email me a magic link" }).click();
    expect(JSON.parse((await guarded).postData() ?? "{}").callbackURL).toBe(
      "/dashboard",
    );
  });

  test("a bounced round trip renders the right copy for each cause", async ({
    page,
  }) => {
    // The linking refusal from D2. The user is told what happened and what to
    // do — not dropped on a generic error.
    await page.goto("/auth?error=account_not_linked");
    await expect(
      page.getByRole("heading", { name: "That email already has an account" }),
    ).toBeVisible();
    await expect(page.getByText(/Sign in the way you did the first time/)).toBeVisible();
    await expect(page.getByText(/link this provider from settings/)).toBeVisible();

    // A spent magic link: Better Auth 1.6.26 reports a reused and an expired
    // link under the same code, so the copy names both causes.
    await page.goto("/auth?error=INVALID_TOKEN");
    await expect(
      page.getByRole("heading", { name: "That link no longer works" }),
    ).toBeVisible();
    await expect(page.getByText(/already used or past its window/)).toBeVisible();
    await expect(page.getByText(/last 5 minutes/)).toBeVisible();

    await page.goto("/auth?error=EXPIRED_TOKEN");
    await expect(page.getByRole("heading", { name: "That link expired" })).toBeVisible();

    // A declined consent.
    await page.goto("/auth?error=access_denied");
    await expect(
      page.getByRole("heading", { name: "Sign-in was cancelled" }),
    ).toBeVisible();

    // Anything unrecognised still gets a sentence and a way back.
    await page.goto("/auth?error=something_nobody_has_seen");
    await expect(page.getByRole("heading", { name: "That did not work" })).toBeVisible();
    await page.getByRole("button", { name: "Back to sign in" }).click();
    await expect(page.getByRole("heading", { name: SIGN_IN_HEADING })).toBeVisible();
  });

  test("light and dark parity on idle and on error", async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto("/auth");

    const card = page.locator("div.bg-surface").first();
    const lightCard = await card.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );

    // The app pins `forcedTheme="light"`, so parity is asserted by stamping the
    // attribute the token block keys off — the same way E04 task 008 did it.
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    await expect(page.locator('html[data-theme="dark"]')).toHaveCount(1);

    const darkCard = await card.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(darkCard).not.toBe(lightCard);

    // Every idle control is still there and still readable.
    await expect(page.getByRole("heading", { name: SIGN_IN_HEADING })).toBeVisible();
    await expect(page.locator("button[data-provider]")).toHaveCount(2);
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Email me a magic link" }),
    ).toBeVisible();

    // The provider slab inverts with the theme, which is what keeps Google's
    // button a valid Google button in both blocks.
    const slab = await page
      .locator("button[data-provider='google']")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(slab).not.toBe(darkCard);

    // The error panel too.
    await page.goto("/auth?error=INVALID_TOKEN");
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    await expect(
      page.getByRole("heading", { name: "That link no longer works" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Send a new link" })).toBeVisible();

    // The session endpoint is down in this environment and better-auth's client
    // logs that; nothing else may write to the console.
    const unexpected = errors.filter((e) => !/get-session|500|Failed to load resource/i.test(e));
    expect(unexpected, `console errors: ${unexpected.join(" | ")}`).toEqual([]);
  });
});
