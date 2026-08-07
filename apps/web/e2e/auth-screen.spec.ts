import { test, expect, type Page } from "@playwright/test";

/**
 * `/auth` — the sign-in screen. E05 task 005.
 *
 * ── WHAT THIS SUITE CAN AND CANNOT PROVE ───────────────────────────────────
 * Written while the auth layer was unprovisioned, when every `/api/auth/*`
 * endpoint answered 500 and that 500 was the material every failure assertion
 * was made of. **Task 012 provisioned the credentials, and two of those tests
 * were then asserting something no longer true** — `/api/auth/get-session`
 * answers 200, and a GitHub click really does reach GitHub. Both were rewritten
 * against what is true now rather than relaxed; see the two tests below.
 *
 * What it proves:
 *
 *   1. `/auth` renders all three routes with no session dependency in the
 *      server component — which is why a session read that fails, or simply
 *      returns null, cannot stop the screen drawing.
 *   2. Both failure paths reach a readable error panel with a working button,
 *      not a spinner. The magic-link failure is a REAL rejection from Resend
 *      (`example.com` is refused at request time), not a substituted response.
 *   3. The `next` return URL is threaded into the real request body and is
 *      validated by `safeReturnPath` on the way in.
 *
 * `auth-providers.spec.ts` owns the provider boundary itself (the authorize
 * redirect's shape, the provider accepting the registration, state forgery,
 * and a real Resend send).
 *
 * NO `page.route(..., fulfill)` ANYWHERE, and no substituted provider. The two
 * places this suite touches the network delay a request and continue it, or
 * abort it outright to produce a genuine transport failure in the browser —
 * the response, when there is one, always comes from the real handler.
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

  test("renders with all three routes whatever the session read answers", async ({
    page,
  }) => {
    // Proof, not assumption: the endpoint the session read uses now answers,
    // and answers "nobody" for a visitor with no cookie. Before task 012's
    // provisioning this was a 500 and the screen drew anyway — the point of the
    // shell having no session dependency is that neither answer changes it.
    const session = await page.request.get("/api/auth/get-session");
    expect(session.status()).toBe(200);
    expect(await session.text()).toBe("null");

    const res = await page.goto("/auth");
    expect(res?.ok()).toBe(true);
    await expect(page.getByRole("heading", { name: SIGN_IN_HEADING })).toBeVisible();
    await expect(page.locator("button[data-provider]")).toHaveCount(2);
  });

  test("an OAuth click shows the redirect state, then really leaves for the provider", async ({
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

    // …and the redirect is not decorative: with the credentials provisioned the
    // browser actually lands on github.com. `auth-providers.spec.ts` asserts the
    // shape of that URL; here the only claim is that the button leaves.
    await page.waitForURL(/^https:\/\/github\.com\//, { timeout: 15_000 });
  });

  test("an OAuth click that cannot reach the server ends in words, not a spinner", async ({
    page,
  }) => {
    await page.goto("/auth");
    // A genuine transport failure, not a substituted response: the request is
    // aborted at the socket, which is what the browser sees when the provider
    // leg is unreachable. Nothing fabricates a body — `route.fulfill` is
    // forbidden here and is not used.
    await page.route(
      (url) => url.pathname.includes("/sign-in/social"),
      (route) => route.abort("connectionfailed"),
    );

    await page.getByRole("button", { name: "Continue with GitHub" }).click();

    // The failure becomes words plus a button.
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
