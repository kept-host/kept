import { limitsFor } from "@kept/shared";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { and, eq } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import {
  JUST_PUBLISHED,
  KEPT_TOAST,
  LINK_COPIED_TOAST,
  PUBLISHED_KEPT_TOAST,
  atLimitPublishToast,
} from "../lib/sites/display";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import {
  cleanup,
  drop,
  hydrated,
  newScope,
  publishOwned,
  seedKept,
  signInAs,
  titledHtml,
  SKIP_OWNER_UI,
} from "./owner-fixtures";
import { waitForTokensApplied } from "./tokens-applied";

/**
 * The publish moment on the Pages home — E06 task 015: the sheet closing on
 * send, the mint card (the landing's minting language, rebuilt from tokens),
 * the new card's arrival timed from its mount, the toast's Copy link, the keep
 * moment, the card hover, and reduced-motion parity.
 *
 * NO MOCKS. Every publish is a real `POST /api/sites` against the dev stack.
 * To SEE the in-between states, the real request (or the real RSC refresh that
 * follows it) is HELD in `page.route` until the test lets it go, then
 * continued unchanged — a delay on the real call, never a fabricated answer.
 * The failure drill is a real refusal: the session cookie is taken out of the
 * jar, so the route answers its own 401.
 *
 * SKIPS without dev credentials: CI runs fork PRs with no secrets.
 */
const scope = newScope();
const FREE = limitsFor("free");

/** A request held until the test releases it, then sent on exactly as it was. */
interface Hold {
  release: () => void;
  /** Resolves when the browser has sent the held request. */
  reached: Promise<void>;
}

/** Hold the next request `matches` accepts. Later ones pass straight through. */
async function holdNext(page: Page, matches: (route: Route) => boolean): Promise<Hold> {
  let release!: () => void;
  let reach!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (reach = resolve));
  let used = false;
  const handler = async (route: Route) => {
    if (used || !matches(route)) return route.fallback();
    used = true;
    reach();
    await gate;
    await route.continue();
  };
  await page.route("**/*", handler);
  return { release, reached };
}

const isPublish = (route: Route) =>
  route.request().method() === "POST" && new URL(route.request().url()).pathname === "/api/sites";

/** The RSC fetch `router.refresh()` makes for the Pages home (not a link prefetch). */
const isRefresh = (route: Route) => {
  const headers = route.request().headers();
  return (
    new URL(route.request().url()).pathname === "/dashboard" &&
    headers["rsc"] === "1" &&
    headers["next-router-prefetch"] === undefined
  );
};

/** WCAG 2.x contrast ratio between two computed `rgb()`/`rgba()` colours. */
function contrast(a: string, b: string): number {
  const luminance = (css: string) => {
    const [r, g, bl] = css.match(/[\d.]+/g)!.slice(0, 3).map(Number) as [number, number, number];
    const lin = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(bl);
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Names of every animation on `target` and its subtree — finished ones that still fill included. */
const animationNames = (target: Locator) =>
  target.evaluate((node) =>
    node.getAnimations({ subtree: true }).map((animation) => (animation as CSSAnimation).animationName),
  );

/** Names of the animations RUNNING on `target` and its subtree right now. */
const runningAnimations = (target: Locator) =>
  target.evaluate((node) =>
    node
      .getAnimations({ subtree: true })
      .filter((animation) => animation.playState === "running")
      .map((animation) =>
        animation instanceof CSSAnimation
          ? animation.animationName
          : animation instanceof CSSTransition
            ? `transition:${animation.transitionProperty}`
            : "script",
      ),
  );

test.describe("the publish moment", () => {
  test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
  test.describe.configure({ timeout: LIVE_STACK_TIMEOUT * 2 });

  test.beforeAll(async () => {
    if (SKIP_OWNER_UI) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_OWNER_UI) return;
    await cleanup(scope);
    await closeDb();
  });

  const card = (page: Page, siteId: string) =>
    page.locator(`[data-testid="home-card"][data-site-id="${siteId}"]`);

  const anywhere = (page: Page) => page.getByRole("heading", { level: 1, name: "Your pages" });

  /** The row a UI publish created, registered for teardown. */
  async function ownRow(userId: string, title: string) {
    const [row] = await db
      .select({ id: schema.sites.id, slug: schema.sites.slug, expiresAt: schema.sites.expiresAt })
      .from(schema.sites)
      .where(and(eq(schema.sites.ownerId, userId), eq(schema.sites.title, title)));
    expect(row, `the publish of "${title}" created a page`).toBeDefined();
    scope.siteIds.push(row!.id);
    scope.slugs.add(row!.slug);
    return row!;
  }

  test("AC1 + AC2 + AC3 + AC8 + AC9: the sheet closes on send, the mint card keeps it, and the card arrives — its ring timed from its mount", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    await publishOwned(page, baseURL!, scope, "E06-015 neighbour");
    await page.goto("/dashboard");
    await waitForTokensApplied(page);
    await hydrated(page);

    const post = await holdNext(page, isPublish);
    const title = `E06-015 pasted ${crypto.randomUUID().slice(0, 8)}`;
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    const sheet = page.getByTestId("publish-sheet");
    await sheet.getByRole("button", { name: "Or paste HTML" }).click();
    await sheet.getByRole("textbox", { name: "Paste HTML" }).fill(titledHtml(title));
    await sheet.getByRole("button", { name: "Publish pasted HTML" }).click();
    await post.reached;

    // AC1 — the sheet is gone while the request is still out, so the mint card
    // on the wall is what the owner watches.
    await expect(sheet).toBeHidden();
    const mint = page.getByTestId("mint-card");
    await expect(mint).toHaveAttribute("data-phase", "sending");
    await expect(mint).toContainText("Keeping it…");
    await expect(mint).toContainText("Pasted HTML");
    await expect(mint.locator("svg[data-mascot]")).toHaveCount(1);
    // AC8 — the landing's minting language, moving: the sweep, the spinner, the mascot's bob.
    await expect.poll(() => runningAnimations(mint)).toEqual(
      expect.arrayContaining(["keptScan", "spin", "keptMascotHover"]),
    );

    // The answer lands while the refresh that brings the real card is held:
    // the toast, and the mascot's hop with "It's yours now."
    const refresh = await holdNext(page, isRefresh);
    post.release();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: PUBLISHED_KEPT_TOAST })).toBeVisible({
      timeout: LIVE_STACK_TIMEOUT,
    });
    await expect(mint).toHaveAttribute("data-phase", "landed");
    await expect(mint).toContainText("It's yours now.");
    expect(await animationNames(page.getByTestId("mint-mascot"))).toContain("keptHop");
    await refresh.reached;

    // AC3 — hold the refresh past the whole arrival window. A ring timed from
    // the response would already be over when the card finally mounts.
    await page.waitForTimeout(3_000);
    refresh.release();
    const row = await ownRow(userId, title);
    const arrived = card(page, row.id);
    await expect(arrived).toHaveAttribute("data-highlighted", "true", { timeout: LIVE_STACK_TIMEOUT });
    await expect(arrived).toHaveAttribute("data-arrival", "published");
    await expect(mint).toHaveCount(0);

    // AC2 + AC9 — the arrival: "Just published", "New" for no visits yet, the
    // pulsing LIVE badge, the rise and the one ring pulse.
    await expect(arrived.getByText(JUST_PUBLISHED)).toBeVisible();
    await expect(arrived.getByText("New", { exact: true })).toBeVisible();
    await expect(arrived.getByTestId("live-badge")).toBeVisible();
    expect(await animationNames(arrived)).toEqual(
      expect.arrayContaining(["keptRise", "keptRingPulse", "keptLive"]),
    );

    // Still ringed well after it mounted, then settled — ring, chip, badge and
    // "New" all go.
    await page.waitForTimeout(1_800);
    await expect(arrived).toHaveAttribute("data-highlighted", "true");
    await expect(arrived).not.toHaveAttribute("data-highlighted", "true", { timeout: 3_000 });
    await expect(arrived.getByText(JUST_PUBLISHED)).toHaveCount(0);
    await expect(arrived.getByTestId("live-badge")).toHaveCount(0);
    await expect(arrived.getByText("New", { exact: true })).toHaveCount(0);
  });

  test("AC4 + AC6: the publish toast copies the link and says so, its secondary text is legible, and on a phone it clears the tab bar", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(baseURL!).origin,
    });
    await publishOwned(page, baseURL!, scope, "E06-015 toast neighbour");
    await page.goto("/dashboard");
    await waitForTokensApplied(page);
    await hydrated(page);

    const title = `E06-015 toast ${crypto.randomUUID().slice(0, 8)}`;
    await drop(page, anywhere(page), { name: "toast.html", type: "text/html", body: titledHtml(title) });
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: PUBLISHED_KEPT_TOAST });
    await expect(toast).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    // The pointer rests on the toast: Sonner holds a hovered toast open, so the
    // checks below do not race its four seconds.
    await toast.hover();

    // AC6 — the address under the title clears 4.5:1 on the inverted toast, in
    // both token blocks (dark stamped imperatively, as the dark specs do).
    const description = toast.locator("[data-description]");
    const readContrast = async () => {
      const [fg, bg] = await Promise.all([
        description.evaluate((node) => getComputedStyle(node).color),
        toast.evaluate((node) => getComputedStyle(node).backgroundColor),
      ]);
      return contrast(fg, bg);
    };
    expect(await readContrast(), "light: --text-inverse-muted on --text").toBeGreaterThanOrEqual(4.5);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    expect(await readContrast(), "dark: --text-inverse-muted on --text").toBeGreaterThanOrEqual(4.5);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

    // AC4 — Copy link copies the live URL; the SAME toast now says "Link copied"
    // and keeps its action.
    await toast.getByRole("button", { name: "Copy link" }).click();
    const copied = page.locator("[data-sonner-toast]").filter({ hasText: LINK_COPIED_TOAST });
    await expect(copied).toBeVisible();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: PUBLISHED_KEPT_TOAST })).toHaveCount(0);
    await expect(copied.getByRole("button", { name: "Copy link" })).toBeVisible();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());

    const row = await ownRow(userId, title);
    // The card's own Open ↗ link is the page's live URL, as the server built it.
    const liveUrl = await card(page, row.id).locator('a[target="_blank"]').first().getAttribute("href");
    expect(liveUrl).toContain(row.slug);
    expect(clipboard).toBe(liveUrl);

    // On a phone (and up to `md`) toasts sit above the tab bar. There is one
    // Toaster and one offset, so the card menu's Copy link raises a toast in
    // the same place a publish toast lands — without another publish.
    for (const width of [390, 700]) {
      await page.mouse.move(0, 0);
      await page.setViewportSize({ width, height: 844 });
      await card(page, row.id).getByRole("button", { name: /^More actions for / }).click();
      await page.getByRole("menuitem", { name: "Copy link" }).click();
      await expect(page.locator("[data-sonner-toast]").filter({ hasText: LINK_COPIED_TOAST }).first()).toBeVisible();
      const tabBar = await page.locator("[data-tab-bar]").boundingBox();
      await expect
        .poll(
          () =>
            page
              .locator("[data-sonner-toast]")
              .evaluateAll((toasts) => Math.max(...toasts.map((node) => node.getBoundingClientRect().bottom))),
          { message: `at ${width}px every toast clears the tab bar` },
        )
        .toBeLessThanOrEqual(tabBar!.y);
    }
  });

  test("AC1: a refused publish turns the mint card into the server's own error, with Try again (the same bytes) and dismiss", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    await publishOwned(page, baseURL!, scope, "E06-015 failure neighbour");
    await page.goto("/dashboard");
    await waitForTokensApplied(page);
    await hydrated(page);

    // A real refusal: the session cookie leaves the jar, so the route itself
    // answers 401 with its own sentence.
    const cookies = await page.context().cookies();
    await page.context().clearCookies();

    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/sites") {
        posts.push(request.postData() ?? "");
      }
    });

    await drop(page, anywhere(page), { name: "first.html", type: "text/html", body: titledHtml("E06-015 dismissed") });
    const mint = page.getByTestId("mint-card");
    await expect(mint).toHaveAttribute("data-phase", "failed", { timeout: LIVE_STACK_TIMEOUT });
    await expect(mint.getByRole("alert")).toHaveText("Sign in to manage this page.");
    await mint.getByRole("button", { name: "Dismiss" }).click();
    await expect(mint).toHaveCount(0);

    const title = `E06-015 retried ${crypto.randomUUID().slice(0, 8)}`;
    await drop(page, anywhere(page), { name: "retried.html", type: "text/html", body: titledHtml(title) });
    await expect(mint).toHaveAttribute("data-phase", "failed", { timeout: LIVE_STACK_TIMEOUT });
    await expect(mint).toContainText("retried.html");

    await page.context().addCookies(cookies);
    await mint.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText(PUBLISHED_KEPT_TOAST)).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    const row = await ownRow(userId, title);
    await expect(card(page, row.id)).toHaveAttribute("data-arrival", "published", { timeout: LIVE_STACK_TIMEOUT });
    expect(posts, "Try again re-sent exactly the bytes that failed").toHaveLength(3);
    expect(posts[2]).toBe(posts[1]);
  });

  test("AC5: Keep fades the draft where it stands, then the page arrives on the wall, ringed", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const draft = await publishOwned(page, baseURL!, scope, "E06-015 keep me");
    const demoted = await page.request.post(`${baseURL}/api/sites/${draft.siteId}/demote`, {
      headers: { origin: new URL(baseURL!).origin },
    });
    expect(demoted.status(), await demoted.text()).toBe(200);

    await page.goto("/dashboard");
    await waitForTokensApplied(page);
    await hydrated(page);
    const strip = page.getByTestId("drafts-strip");
    const leaving = strip.locator(`[data-site-id="${draft.siteId}"]`);

    const refresh = await holdNext(page, isRefresh);
    await leaving.getByTestId("keep-button").click();
    await expect(page.getByText(KEPT_TOAST)).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    await expect(leaving.getByTestId("keep-button")).toHaveText(/^Kept/);
    // Faded to the design's .55, over its .4 s transition.
    await expect.poll(() => leaving.evaluate((node) => getComputedStyle(node).opacity)).toBe("0.55");
    expect(await leaving.evaluate((node) => getComputedStyle(node).transitionDuration)).toBe("0.4s");
    await refresh.reached;
    refresh.release();

    const arrived = page.getByTestId("kept-wall").locator(`[data-site-id="${draft.siteId}"]`);
    await expect(arrived).toHaveAttribute("data-arrival", "kept", { timeout: LIVE_STACK_TIMEOUT });
    await expect(arrived).toHaveAttribute("data-highlighted", "true");
    await expect(arrived.getByTestId("live-badge")).toBeVisible();
    await expect(arrived.getByText(JUST_PUBLISHED)).toHaveCount(0);
    await expect(leaving).toHaveCount(0);
  });

  test("AC7: every card variant lifts on hover over the design's 160 ms — and only its shadow changes under reduced motion", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const kept = await publishOwned(page, baseURL!, scope, "E06-015 hover kept");
    const draft = await publishOwned(page, baseURL!, scope, "E06-015 hover draft");
    expect(draft.outcome).toBe("kept");
    const demoted = await page.request.post(`${baseURL}/api/sites/${draft.siteId}/demote`, {
      headers: { origin: new URL(baseURL!).origin },
    });
    expect(demoted.status()).toBe(200);

    const motion = (article: Locator) =>
      article.evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          property: style.transitionProperty,
          duration: style.transitionDuration,
          translate: style.translate,
        };
      });

    for (const [view, id] of [
      ["", kept.siteId],
      ["?view=list", kept.siteId],
      ["", draft.siteId],
    ] as const) {
      await page.goto(`/dashboard${view}`);
      await waitForTokensApplied(page);
      const article = card(page, id).locator("article");
      await expect(article).toBeVisible();
      const resting = await motion(article);
      expect(resting.property).toContain("box-shadow");
      expect(resting.property).toContain("translate");
      expect(resting.duration).toBe("0.16s");
      await article.hover();
      await expect.poll(async () => (await motion(article)).translate).toBe("0px -2px");
    }

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/dashboard");
    await waitForTokensApplied(page);
    const article = card(page, kept.siteId).locator("article");
    await article.hover();
    const reduced = await motion(article);
    expect(reduced.duration).toBe("0s");
    expect(reduced.translate).toBe("none");
  });

  test("AC10: under reduced motion the whole flow completes and nothing on the mint card or the new card moves", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    await seedKept(scope, userId, FREE.keptPages - 1);
    await publishOwned(page, baseURL!, scope, "E06-015 reduced last slot");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/dashboard");
    await waitForTokensApplied(page);
    await hydrated(page);

    // At the limit, so the new page lands as a draft in the strip.
    const post = await holdNext(page, isPublish);
    const title = `E06-015 reduced ${crypto.randomUUID().slice(0, 8)}`;
    await drop(page, anywhere(page), { name: "reduced.html", type: "text/html", body: titledHtml(title) });
    await post.reached;
    const mint = page.getByTestId("mint-card");
    await expect(mint).toContainText("Keeping it…");
    expect(await runningAnimations(mint), "a still spinner, no sweep, a resting mascot").toEqual([]);

    post.release();
    await expect(page.getByText(atLimitPublishToast(FREE.keptPages))).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    const row = await ownRow(userId, title);
    expect(row.expiresAt).not.toBeNull();
    const arrived = page.getByTestId("drafts-strip").locator(`[data-site-id="${row.id}"]`);
    await expect(arrived).toHaveAttribute("data-highlighted", "true", { timeout: LIVE_STACK_TIMEOUT });
    await expect(arrived.getByText(JUST_PUBLISHED)).toBeVisible();
    await expect(arrived.getByText(/^Draft · /)).toBeVisible();
    await expect(arrived.getByTestId("live-badge"), "a draft shows its draft chip, not LIVE").toHaveCount(0);
    expect(await runningAnimations(arrived), "no rise, no pulse, no transition").toEqual([]);
    await expect(arrived).not.toHaveAttribute("data-highlighted", "true", { timeout: 5_000 });
    expect(await runningAnimations(arrived), "and the ring leaves without a transition").toEqual([]);
  });
});
