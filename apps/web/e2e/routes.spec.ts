import { test, expect, type Page } from "@playwright/test";
import { config } from "dotenv";

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
    const res = await page.goto("/stats");
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
    const res = await page.goto("/promise");
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
