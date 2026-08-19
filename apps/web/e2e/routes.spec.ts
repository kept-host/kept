import { test, expect, type Page } from "@playwright/test";
import { config } from "dotenv";

import { gotoWithTokensApplied } from "./tokens-applied";

/**
 * Route smoke: the `(app)` gate, /auth, /stats and /promise.
 *
 * /stats and /promise are still marketing shells (their live data lands in
 * E09). We assert they respond OK, render their stable heading, and produce no
 * console errors — plus, for /stats, that the pre-launch zero baseline is
 * reported honestly rather than filled in with an invented figure. /auth and
 * /dashboard are no longer shells at all; see the two describes below.
 */
config({ path: ".env.local", quiet: true });

/**
 * Everything `createAuth()` validates before the `(app)` gate can answer.
 *
 * The gate redirect looks environment-free — a signed-out visitor has no cookie
 * to read — but `requireSession()` reaches `auth.api.getSession`, and the first
 * touch of `auth` constructs the whole Better Auth instance. With the slots
 * empty that construction throws by design (`lib/storage/env.ts`), so /dashboard
 * answers 500 and never reaches the redirect. That is a missing OAuth app, not a
 * broken gate, so the drill skips rather than asserting something weaker and
 * untrue. Nothing here is mocked to work around it.
 */
const AUTH_VARS = [
  "BETTER_AUTH_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
] as const;

const missingAuthVars = AUTH_VARS.filter((name) => !process.env[name]?.trim());

const SKIP_AUTH: string | false =
  missingAuthVars.length > 0
    ? `auth credentials absent (${missingAuthVars.join(", ")}) — run locally with apps/web/.env.local`
    : false;

/**
 * The `/api/anon/` drill further down is a LIVE-STORE drill, not a URL-space
 * one. Three of those four handlers resolve the token against Postgres before
 * they can answer "unknown" at all, and `keep` reads the session before it even
 * reads the token — so with `DATABASE_URL` empty (`lib/db/index.ts` throws by
 * design, and the client is lazy precisely so a secretless build still passes)
 * or the auth slots empty, every one of them answers 500 and the 404 the drill
 * is after is unreachable. That is missing config failing loud, which is the
 * intended behaviour, so the drill skips rather than asserting something weaker.
 */
const missingLiveVars = ["DATABASE_URL", ...AUTH_VARS].filter(
  (name) => !process.env[name]?.trim(),
);

const SKIP_LIVE: string | false =
  missingLiveVars.length > 0
    ? `database or auth credentials absent (${missingLiveVars.join(", ")}) — run locally with apps/web/.env.local`
    : false;

/**
 * The two zero-console-error drills below navigate through
 * `gotoWithTokensApplied`. A stylesheet the `--experimental-https` dev server
 * drops lands in `errors` as `Failed to load resource` and fails them for a
 * reason that has nothing to do with the route — see `tokens-applied.ts`.
 */
function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

/**
 * /dashboard is no longer a page this suite can just fetch — E05 task 004 put
 * `app/(app)/layout.tsx` in front of the whole route group, so a signed-out
 * visitor never renders the placeholder underneath it. What is worth asserting
 * is the gate's *contract*: it does not merely refuse, it remembers. The path
 * comes from the `x-kept-pathname` header `middleware.ts` stamps and is put back
 * on the sign-in URL by `signInHref`, so the visitor resumes where they were
 * headed instead of being dumped on the landing page. `auth-screen.spec.ts` owns
 * the other end of that contract — what `/auth` does with the `next` it is given.
 */
test.describe("the (app) route gate", () => {
  test.skip(!!SKIP_AUTH, SKIP_AUTH || undefined);

  test("/dashboard sends a signed-out visitor to sign in, carrying where to resume", async ({
    page,
  }) => {
    const res = await page.goto("/dashboard");
    expect(res?.ok()).toBe(true);

    // Landed on the real sign-in screen, not on the gated page.
    await expect(page).toHaveURL(/\/auth\?/);
    await expect(
      page.getByRole("heading", { name: "Sign in to kept" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Dashboard placeholder" }),
    ).toHaveCount(0);

    // Asserted decoded, because the contract is the path — not the exact
    // percent-encoding the browser chose to keep it in.
    expect(new URL(page.url()).searchParams.get("next")).toBe("/dashboard");
  });
});

/**
 * D3, at the edge of the URL space rather than in the handlers — E05 task 012.
 *
 * Task 013 moved every anonymous route under `/api/anon/`, which broke the API
 * contract deployed at `dev-v0.1.5` deliberately and with no compatibility
 * redirect. The absence of that redirect is the security property: a 301 or 307
 * would resurrect a retired URL that carries a BEARER CREDENTIAL in its path,
 * and the token would then be handed to whatever the redirect resolved to —
 * plus leaked through `Referer`. So the retired paths must answer an ordinary,
 * boring 404, and must not answer with a `Location`.
 *
 * The retired-path test needs no credentials — a made-up token is enough,
 * because the assertion is that the route does not exist at all. The live
 * `/api/anon/` counterpart does need them, and skips without; see `SKIP_LIVE`.
 */
test.describe("the retired anonymous API paths", () => {
  const RETIRED_TOKEN = "e05012retiredpathprobe000000000000000000";

  test("the pre-D3 `/api/sites/:anonToken/*` URLs 404 and never redirect", async ({
    request,
  }) => {
    const attempts: [string, "get" | "post" | "delete"][] = [
      [`/api/sites/${RETIRED_TOKEN}`, "delete"],
      [`/api/sites/${RETIRED_TOKEN}/replace`, "post"],
      [`/api/sites/${RETIRED_TOKEN}/reminder`, "post"],
    ];

    for (const [path, method] of attempts) {
      const response = await request[method](path, { maxRedirects: 0 });
      expect(response.status(), `${method.toUpperCase()} ${path}`).toBe(404);
      expect(response.headers()["location"], `${method.toUpperCase()} ${path}`).toBeUndefined();
    }
  });

  test("the `/api/anon/` namespace answers those same shapes with no session", async ({
    request,
  }) => {
    test.skip(!!SKIP_LIVE, SKIP_LIVE || undefined);

    // The token is fictional, so the honest answer is the uniform 404 the
    // anonymous manage API gives any unknown token — what matters here is that
    // the ROUTE exists and gates on the token rather than on a session (a 401
    // would mean publish-before-signup had grown a sign-in wall).
    const attempts: [string, "post" | "delete"][] = [
      [`/api/anon/${RETIRED_TOKEN}`, "delete"],
      [`/api/anon/${RETIRED_TOKEN}/replace`, "post"],
      [`/api/anon/${RETIRED_TOKEN}/reminder`, "post"],
      [`/api/anon/${RETIRED_TOKEN}/keep`, "post"],
    ];

    for (const [path, method] of attempts) {
      const response = await request[method](path, { maxRedirects: 0 });
      const where = `${method.toUpperCase()} ${path}`;
      // 404 (unknown token), or 400 where the body is validated first. A 405
      // would mean the method never reached a handler at all.
      expect([400, 401, 404], where).toContain(response.status());
    }

    // Only `keep` may answer 401 — it is the one anonymous route that needs a
    // session to have anywhere to put the page. The other three must stay
    // reachable with no session at all, because publish-before-signup is the
    // product and a gate that crept onto that path is launch-blocking.
    for (const [path, method] of attempts.slice(0, 3)) {
      const response = await request[method](path, { maxRedirects: 0 });
      expect(
        response.status(),
        `${method.toUpperCase()} ${path} must not gate on a session`,
      ).not.toBe(401);
    }
  });
});

test.describe("stub routes", () => {
  // /auth is no longer a stub — E05 task 005 built the real sign-in screen, and
  // `auth-screen.spec.ts` owns it. This keeps only the smoke assertion that
  // belongs with the other route shells: the page answers, and the placeholder
  // heading this suite used to look for is gone for good.
  test("/auth responds with the real sign-in screen, not the old stub", async ({
    page,
  }) => {
    const res = await page.goto("/auth");
    expect(res?.ok()).toBe(true);
    await expect(
      page.getByRole("heading", { name: "Sign in to kept" }),
    ).toBeVisible();
    await expect(page.getByText("Sign-in placeholder")).toHaveCount(0);
  });

  test("/stats responds and reports the zero baseline honestly", async ({
    page,
  }) => {
    const errors = trackConsoleErrors(page);
    const res = await gotoWithTokensApplied(page, "/stats");
    expect(res?.ok()).toBe(true);
    await expect(page).toHaveTitle("Stats · kept");
    await expect(page.getByRole("heading", { name: "Stats" })).toBeVisible();

    // Nothing is deployed yet, so the figures must read as a real zero and an
    // unmeasured uptime — never a placeholder number or an unearned 100%.
    const figures = page.locator("dl > div");
    await expect(figures).toHaveCount(3);
    await expect(
      figures.filter({ hasText: "Pages kept" }).locator("dd"),
    ).toHaveText("0");
    await expect(
      figures.filter({ hasText: "Uptime" }).locator("dd"),
    ).toHaveText("Not yet measured");
    await expect(
      figures.filter({ hasText: "Infra cost this month" }).locator("dd"),
    ).toHaveText("€0.00");

    const bodyText = await page.evaluate(() => document.body.innerText ?? "");
    expect(bodyText).not.toMatch(/100%/);
    expect(bodyText).not.toMatch(/1,?284/);

    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("/promise responds and states the wind-down commitment", async ({
    page,
  }) => {
    const errors = trackConsoleErrors(page);
    const res = await gotoWithTokensApplied(page, "/promise");
    expect(res?.ok()).toBe(true);
    await expect(page).toHaveTitle("The promise · kept");
    await expect(
      page.getByRole("heading", { name: "If kept ever winds down" }),
    ).toBeVisible();
    await expect(page.getByText(/we announce the sunset/)).toBeVisible();
    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("/promise reports the same zero baseline vocabulary as /stats", async ({
    page,
  }) => {
    await page.goto("/promise");

    // The wind-down promise is what replaced the donation ask; neither the
    // funding vocabulary nor an unearned uptime figure may appear here.
    const bodyText = await page.evaluate(() => document.body.innerText ?? "");
    expect(bodyText).not.toMatch(/Open Collective/i);
    expect(bodyText).not.toMatch(/donat/i);
    expect(bodyText).not.toMatch(/supporter/i);
    expect(bodyText).not.toMatch(/100%/);
  });

  test("both marketing routes link back to the landing page", async ({
    page,
  }) => {
    for (const route of ["/stats", "/promise"]) {
      await page.goto(route);
      const back = page.getByRole("link", { name: /Back to kept/ });
      await expect(back).toHaveCount(1);
      await expect(back).toHaveAttribute("href", "/");

      // The link actually navigates — the landing page is the destination.
      await back.click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page).toHaveTitle("kept");
    }
  });
});
