import {
  DRAFT_GRACE_DAYS,
  DRAFT_TTL_DAYS,
  KEPT_PAGE_LIMIT,
  generateAnonToken,
  hashToken,
} from "@kept/shared";
import { expect, test, type Page } from "@playwright/test";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { PENDING_KEEP_COOKIE } from "../lib/auth/pending-keep";

/**
 * The zero-context keep, end to end — E05 task 009.
 *
 * A stranger opens a link an agent handed them, presses one button, signs in,
 * and their page is permanent at the same address. Everything between those two
 * moments is a redirect through somebody else's server, and the thing that has
 * to survive it is a bearer token that must never appear in a URL. That is what
 * this file asserts:
 *
 *   1. Pressing "Keep it forever" parks the intent in an httpOnly, `Lax`,
 *      short-TTL cookie and hands the visitor to `/auth/keep` — with the token
 *      in no URL, no form field and no request that leaves the origin.
 *   2. Signed in, `/auth/callback` spends the cookie exactly once: the page is
 *      kept, the bearer token is dead, and a **replay of the same URL keeps
 *      nothing** because the cookie is already gone.
 *   3. At `KEPT_PAGE_LIMIT` the visitor is not refused — they land on the swap
 *      prompt with the page owned and its countdown still running.
 *   4. A token that resolves to nothing gets the one indistinguishable answer,
 *      as a readable screen rather than a 404 or a stack trace.
 *   5. Already signed in, the sign-in screen is skipped entirely.
 *
 * NO MOCKS. Real dev Neon branch, real Better Auth instance, real signed cookie,
 * real HTTP. The one substitution is the **inbox**: with no `RESEND_API_KEY`
 * provisioned the magic-link plugin cannot hand a URL to Resend, so the
 * verification value is written through the plugin's own storage contract and
 * the REAL `/api/auth/magic-link/verify` is then called — the same shape
 * `anon-keep-api.spec.ts` established.
 *
 * SKIPS on all seven variables `createAuth()` validates, not just the secret:
 * the first touch of `auth` constructs the whole instance and throws if any is
 * empty, and `startKeep` reads a session, so with the OAuth apps unprovisioned
 * the very first click 500s. That is a missing OAuth app, not a broken flow.
 */
config({ path: ".env.local", quiet: true });

const REQUIRED = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
] as const;

const missing = REQUIRED.filter((name) => !process.env[name]?.trim());

const SKIP: string | false =
  missing.length > 0
    ? `auth/dev credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local`
    : false;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How long "press the button, land on the outcome screen" is allowed to take.
 *
 * NOT A FLAKE CONCESSION — a measured budget. A keep is roughly ten Postgres
 * round trips against a REMOTE Neon branch: the session read, the profile read,
 * `resolveAnonToken`, then `BEGIN` → `lockOwner` → `lockSite` → `countKept` →
 * `UPDATE` → `COMMIT`. Measured against the dev branch (eu-central-1) a single
 * `select 1` ranges from 47 ms to 1193 ms depending on pooler warmth and Neon's
 * scale-to-zero, so the whole press-to-screen path legitimately lands anywhere
 * between ~1 s and ~9 s.
 *
 * Playwright's DEFAULT expect budget is 5000 ms, which sits in the middle of
 * that distribution — so these tests passed or failed on which side of the
 * median the database happened to be, which is exactly the intermittency this
 * file showed. The assertions themselves are unchanged: the same URL, the same
 * heading and the same committed rows are still required. Only the waiting is.
 *
 * ⚠️ A TIMEOUT HERE MASQUERADES AS A SERVER BUG. When the assertion gave up
 * first, the test ended, `afterAll` deleted the user and the site, and the keep
 * transaction — still in flight — then found its `SELECT … FOR UPDATE` rows
 * gone and logged `No profile <uuid>` or `SiteNotFoundError`. Those lines are a
 * CONSEQUENCE of the teardown racing an unfinished request, not a cause. If
 * they reappear, suspect the budget below before suspecting `lib/sites/keep.ts`.
 */
const KEEP_TIMEOUT = 30_000;

/**
 * How long a token-driven colour is allowed to take to actually paint.
 *
 * Same shape of cause as `KEEP_TIMEOUT`, different resource: the suite runs
 * fully parallel against a single dev server that compiles and serves CSS on
 * demand, so a computed background can be read before the stylesheet lands —
 * or, as `openWithTokensApplied` documents, never land at all on that
 * navigation. Split three ways across the retries there.
 */
const PAINT_TIMEOUT = 20_000;

test.describe("the pending-keep round trip", () => {
  test.skip(!!SKIP, SKIP || undefined);

  // Several tests do two or three full keeps in sequence; at the slow end of the
  // latency range above that alone exceeds Playwright's default 30 s per test.
  test.describe.configure({ timeout: 120_000 });

  const createdUserIds: string[] = [];
  const createdSiteIds: string[] = [];

  test.afterAll(async () => {
    if (SKIP) return;
    if (createdSiteIds.length) {
      await db.delete(schema.sites).where(inArray(schema.sites.id, createdSiteIds));
    }
    if (createdUserIds.length) {
      // Cascades `profiles`, `session` and `account`.
      await db.delete(schema.user).where(inArray(schema.user.id, createdUserIds));
    }
    await closeDb();
  });

  /**
   * A magic link, issued the way the plugin issues one.
   *
   * The inbox is the ONE thing substituted: with no Resend key provisioned the
   * plugin cannot hand a URL to an email service, so the verification value is
   * written through the plugin's own storage contract and the REAL
   * `/api/auth/magic-link/verify` is then opened. Everything downstream of that
   * URL — the session mint, the profile bootstrap, the `callbackURL` redirect —
   * is Better Auth's own code.
   */
  async function magicLink(callbackURL?: string): Promise<string> {
    const { auth } = await import("../lib/auth");
    const ctx = await auth.$context;
    const verification = crypto.randomUUID().replace(/-/g, "");
    const email = `e05-009-${verification.slice(0, 8)}@kept-e05-009.invalid`;

    await ctx.internalAdapter.createVerificationValue({
      identifier: verification,
      value: JSON.stringify({ email, name: "E05-009 keep drill" }),
      expiresAt: new Date(Date.now() + 300_000),
    });

    const url = `/api/auth/magic-link/verify?token=${verification}`;
    return callbackURL ? `${url}&callbackURL=${encodeURIComponent(callbackURL)}` : url;
  }

  /** A real session in the browser context the rest of the test drives. */
  async function signIn(page: Page, baseURL: string): Promise<string> {
    const response = await page.request.get(`${baseURL}${await magicLink()}`);
    expect(response.status(), await response.text()).toBe(200);
    const body = (await response.json()) as { user: { id: string } };
    createdUserIds.push(body.user.id);
    return body.user.id;
  }

  /** An anonymous draft with a REAL bearer token; only its digest is stored. */
  async function makeAnonSite(): Promise<{ id: string; slug: string; token: string }> {
    const id = crypto.randomUUID();
    const slug = `e05-009-flow-${id.slice(0, 12)}`;
    const token = generateAnonToken();
    const expiresAt = new Date(Date.now() + DRAFT_TTL_DAYS * MS_PER_DAY);

    await db.insert(schema.sites).values({
      id,
      slug,
      status: "live",
      region: "auto",
      ownerId: null,
      anonTokenHash: await hashToken(token),
      publisherHash: "e05-009-flow",
      expiresAt,
      purgeAfter: new Date(expiresAt.getTime() + DRAFT_GRACE_DAYS * MS_PER_DAY),
      contentHash: "e05-009-flow",
      sizeBytes: 128,
    });
    createdSiteIds.push(id);
    return { id, slug, token };
  }

  /** A kept page on an account, to fill the cap. */
  async function makeKeptSite(ownerId: string): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(schema.sites).values({
      id,
      slug: `e05-009-full-${id.slice(0, 12)}`,
      status: "live",
      region: "auto",
      ownerId,
      anonTokenHash: null,
      publisherHash: "e05-009-flow",
      expiresAt: null,
      purgeAfter: null,
      contentHash: "e05-009-flow",
      sizeBytes: 128,
    });
    createdSiteIds.push(id);
    return id;
  }

  /** A card with no background — what an UNSTYLED card reports. */
  const TRANSPARENT = "rgba(0, 0, 0, 0)";

  /**
   * Open `url` and do not return until the token stylesheet is actually applied.
   *
   * ⚠️ AN INFRASTRUCTURE FAILURE THAT READS EXACTLY LIKE A TOKEN REGRESSION.
   * The local dev server serves `--experimental-https`, and under the suite's
   * parallel load it intermittently drops a static asset: measured directly,
   * `/_next/static/css/app/layout.css` failing with `net::ERR_TOO_MANY_RETRIES`
   * while the document itself loads fine. The card then still carries its
   * `bg-surface` class but computes `rgba(0, 0, 0, 0)` — in BOTH themes. Those
   * two readings compare EQUAL, so `expect(dark).not.toBe(light)` fails and
   * reports a hardcoded colour that does not exist. (The same dropped-asset
   * fault is why `routes.spec.ts` and `smoke.spec.ts` intermittently see
   * `Failed to load resource` console errors; it is a harness fault, not a
   * product one, and CI does not meet it because CI runs a single worker.)
   *
   * A fresh navigation re-requests the asset, so retrying the NAVIGATION is the
   * honest fix: nothing about what this test asserts is relaxed, and a genuine
   * failure to ever apply the tokens still fails, loudly and with a reason.
   */
  async function openWithTokensApplied(
    page: Page,
    url: string,
    background: () => Promise<string>,
  ): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await page.goto(url);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      const deadline = Date.now() + PAINT_TIMEOUT / 3;
      while (Date.now() < deadline) {
        if ((await background()) !== TRANSPARENT) return;
        await page.waitForTimeout(100);
      }
    }
    throw new Error(
      `The token stylesheet never applied to ${url} across 3 navigations — ` +
        "the card stayed transparent, so no theme comparison was possible.",
    );
  }

  async function pendingKeepCookieOf(page: Page) {
    const cookies = await page.context().cookies();
    return cookies.find((cookie) => cookie.name === PENDING_KEEP_COOKIE);
  }

  test("signed out: the intent becomes an httpOnly Lax cookie and the token never enters a URL", async ({
    page,
  }) => {
    const site = await makeAnonSite();

    // Every request the browser makes, so "the token left the origin in a URL"
    // is a claim about observed traffic rather than about the code.
    const urls: string[] = [];
    page.on("request", (request) => urls.push(request.url()));

    await page.goto(`/keep/${site.token}`);
    await page.getByRole("button", { name: "Keep it forever" }).click();

    // Handed to sign-in, carrying task 005's reassurance line.
    await expect(page).toHaveURL("/auth/keep");
    await expect(page.getByText(/it stays exactly where it is/)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Keep this page" }),
    ).toBeVisible();

    const cookie = await pendingKeepCookieOf(page);
    expect(cookie, "the intent must be parked in a cookie").toBeDefined();
    expect(cookie!.httpOnly, "never readable from JavaScript").toBe(true);
    // `Lax`, not `Strict`: the OAuth callback is a top-level GET navigation
    // initiated cross-site, and `Strict` would drop the cookie on exactly the
    // hop it exists for.
    expect(cookie!.sameSite).toBe("Lax");
    expect(cookie!.path).toBe("/");
    // Short-lived — 10-15 minutes, so an abandoned sign-in expires the intent
    // rather than leaving a bearer token in the browser all day.
    const ttlSeconds = cookie!.expires - Date.now() / 1000;
    expect(ttlSeconds).toBeGreaterThan(0);
    expect(ttlSeconds).toBeLessThanOrEqual(15 * 60 + 5);

    // THE ASSERTION THE WHOLE DESIGN EXISTS FOR. `/keep/<token>` is the one URL
    // that legitimately carries it — the visitor typed it. Nothing else may,
    // and nothing off-origin may at all.
    const origin = new URL(page.url()).origin;
    const leaks = urls.filter(
      (url) => url.includes(site.token) && !url.startsWith(`${origin}/keep/`),
    );
    expect(leaks, `the token appeared in: ${leaks.join(", ")}`).toEqual([]);
    expect(urls.filter((url) => !url.startsWith(origin) && url.includes(site.token))).toEqual(
      [],
    );
  });

  test("THE ZERO-CONTEXT FLOW: sign in mid-keep and the page is permanent, same URL", async ({
    page,
    baseURL,
  }) => {
    const site = await makeAnonSite();

    // A stranger, signed out, on a link somebody handed them.
    await page.goto(`/keep/${site.token}`);
    await page.getByRole("button", { name: "Keep it forever" }).click();
    await expect(page).toHaveURL("/auth/keep");
    expect(await pendingKeepCookieOf(page)).toBeDefined();

    // The round trip: a real magic link, opened the way an inbox opens one,
    // pointed at the same resume path the sign-in screen hands the providers.
    await page.goto(`${baseURL}${await magicLink("/auth/callback")}`);

    // Landed permanent, at the same address, with nothing secret in the URL.
    await expect(page).toHaveURL(`/auth/callback/done?outcome=kept&slug=${site.slug}`, {
      timeout: KEEP_TIMEOUT,
    });
    await expect(page.getByRole("heading", { name: "Kept forever" })).toBeVisible();
    await expect(page.getByText(new RegExp(site.slug))).toBeVisible();
    expect(page.url()).not.toContain(site.token);

    const [row] = await db.select().from(schema.sites).where(eq(schema.sites.id, site.id));
    expect(row?.ownerId, "attached to the account that just signed in").not.toBeNull();
    expect(row?.expiresAt, "kept means no clock").toBeNull();
    expect(row?.purgeAfter).toBeNull();
    // After keeping, the account is the authority and the bearer link is dead.
    expect(row?.anonTokenHash).toBeNull();
    if (row?.ownerId) createdUserIds.push(row.ownerId);

    // READ ONCE. The cookie was spent on the way through the callback, so a
    // refresh — or a back button, or a preloader — carries nothing.
    expect(await pendingKeepCookieOf(page)).toBeUndefined();
    await page.goto("/auth/callback");
    // No intent is an ordinary post-sign-in landing, not a second keep attempt.
    await expect(page).toHaveURL("/dashboard", { timeout: KEEP_TIMEOUT });
  });

  test("already signed in: no sign-in screen, no cookie, straight to the outcome", async ({
    page,
    baseURL,
  }) => {
    await signIn(page, baseURL!);
    const site = await makeAnonSite();

    const visited: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
    });

    await page.goto(`/keep/${site.token}`);
    await page.getByRole("button", { name: "Keep it forever" }).click();

    await expect(page).toHaveURL(`/auth/callback/done?outcome=kept&slug=${site.slug}`, {
      timeout: KEEP_TIMEOUT,
    });
    await expect(page.getByRole("heading", { name: "Kept forever" })).toBeVisible();
    // The sign-in screen was never rendered, and no round trip means no intent
    // was ever parked in a cookie.
    expect(visited).not.toContain("/auth/keep");
    expect(visited).not.toContain("/auth");
    expect(await pendingKeepCookieOf(page)).toBeUndefined();

    const [row] = await db.select().from(schema.sites).where(eq(schema.sites.id, site.id));
    expect(row?.expiresAt).toBeNull();
    expect(row?.anonTokenHash).toBeNull();
  });

  test(`at ${KEPT_PAGE_LIMIT} kept pages the visitor gets the swap prompt, not an error`, async ({
    page,
    baseURL,
  }) => {
    const userId = await signIn(page, baseURL!);
    for (let index = 0; index < KEPT_PAGE_LIMIT; index += 1) {
      await makeKeptSite(userId);
    }
    const site = await makeAnonSite();

    await page.goto(`/keep/${site.token}`);
    await page.getByRole("button", { name: "Keep it forever" }).click();

    await expect(page).toHaveURL(/\/auth\/callback\/done\?outcome=draft/, {
      timeout: KEEP_TIMEOUT,
    });
    await expect(
      page.getByRole("heading", { name: "Saved to your account — as a draft" }),
    ).toBeVisible();
    await expect(
      page.getByText(new RegExp(`You're keeping ${KEPT_PAGE_LIMIT} pages`)),
    ).toBeVisible();
    // The countdown is visible, and the entry point into the swap is offered.
    await expect(page.locator("time")).toBeVisible();
    await expect(page.getByRole("link", { name: "Swap it in" })).toBeVisible();

    const [row] = await db.select().from(schema.sites).where(eq(schema.sites.id, site.id));
    // Owned — the cap never loses the page — but still on its clock.
    expect(row?.ownerId).toBe(userId);
    expect(row?.expiresAt).not.toBeNull();
    expect(row?.anonTokenHash).toBeNull();
  });

  /**
   * The outcome screen is the last thing a stranger sees, and it is reached from
   * whatever theme they were already in. The app pins `forcedTheme="light"`, so
   * parity is asserted by stamping the attribute the token block keys off — the
   * same way task 005 and E04 task 008 did it.
   */
  for (const outcome of ["kept", "draft", "gone"] as const) {
    test(`the "${outcome}" outcome screen reads in both themes`, async ({ page }) => {
      const url = `/auth/callback/done?outcome=${outcome}&slug=e05-009-theme-probe&expires=${new Date(
        Date.now() + MS_PER_DAY,
      ).toISOString()}`;

      const card = page.locator("div.bg-surface").first();
      const heading = page.getByRole("heading", { level: 1 });
      const background = () =>
        card.evaluate((el) => getComputedStyle(el).backgroundColor);

      await openWithTokensApplied(page, url, background);
      await expect(heading).toBeVisible();
      const light = await background();

      await page.evaluate(() =>
        document.documentElement.setAttribute("data-theme", "dark"),
      );
      await expect(page.locator('html[data-theme="dark"]')).toHaveCount(1);

      // A card that did not move is a card painted with a hardcoded colour
      // rather than a token — so this still FAILS if the theme flip changes
      // nothing; it merely allows the repaint to land first.
      await expect.poll(background, { timeout: PAINT_TIMEOUT }).not.toBe(light);
      const dark = await background();
      expect(dark).not.toBe(TRANSPARENT);
      expect(dark).not.toBe(light);
      await expect(heading).toBeVisible();
      // Every branch offers a way onward — nobody who just signed in dead-ends.
      await expect(page.getByRole("link").filter({ hasNotText: "kept" })).not.toHaveCount(
        0,
      );
    });
  }

  test("a token that resolves to nothing gets the one indistinguishable answer, readably", async ({
    page,
    baseURL,
  }) => {
    await signIn(page, baseURL!);
    const site = await makeAnonSite();

    // Keep it once, which retires the token…
    await page.goto(`/keep/${site.token}`);
    await page.getByRole("button", { name: "Keep it forever" }).click();
    await expect(page.getByRole("heading", { name: "Kept forever" })).toBeVisible({
      timeout: KEEP_TIMEOUT,
    });

    // …then present the dead token again. The claim screen itself 404s, so the
    // callback branch is reached by replaying the intent directly.
    await page.context().addCookies([
      {
        name: PENDING_KEEP_COOKIE,
        value: site.token,
        url: baseURL!,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await page.goto("/auth/callback");

    await expect(
      page.getByRole("heading", {
        name: "This page has already been kept, or the link has expired",
      }),
    ).toBeVisible({ timeout: KEEP_TIMEOUT });
    // Signed in and not dead-ended: there is a way onward.
    await expect(
      page.getByRole("link", { name: "Go to your dashboard" }),
    ).toBeVisible();
    // No stack trace, no distinguishable reason, no token echoed back.
    expect(await page.content()).not.toContain(site.token);
  });
});
