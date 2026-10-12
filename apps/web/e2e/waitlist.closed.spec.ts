import { generateAnonToken, hashToken } from "@kept/shared";
import { test, expect, type Page } from "@playwright/test";
import { config } from "dotenv";
import { eq } from "drizzle-orm";

import { closeDb, db } from "../lib/db";
import { waitlist } from "../lib/db/schema";
import { keptOpen } from "../lib/launch";
import { drillIp } from "../lib/testing/drill-ip";
import { TURNSTILE_TEST_KEYS } from "../lib/testing/turnstile";
import { unsubscribeToken } from "../lib/waitlist/unsubscribe";

import { LIVE_STACK_TIMEOUT, skipAuth, warmDb } from "./live-stack";

/**
 * A CLOSED deploy — the waitlist (`lib/launch.ts`). Run with
 *
 *   pnpm --filter @kept/web test:e2e:closed
 *
 * which boots the server with `NEXT_PUBLIC_KEPT_OPEN=false` and runs every
 * `*.closed.spec.ts`. The ordinary `test:e2e` run is open (see
 * `playwright.config.ts`) and skips this file. The API side of a closed deploy
 * — the `not_open` 404, the access token, cron — is `closed-access.closed.spec.ts`.
 *
 * What a closed deploy promises, each asserted against the real server:
 *   - a valid page dropped, chosen or pasted opens the waitlist and sends
 *     NOTHING to `/api/publish` — counted off the wire, not intercepted;
 *   - a file that is not a page still gets the drop box's own refusal;
 *   - the nav offers the waitlist where sign-in was;
 *   - the control-plane pages stay reachable (E06a §1: only admins can have a
 *     session), and a page no rule allows lands on the landing;
 *   - joining through the dialog is double opt-in (E06a §3): one pending,
 *     lowercased row with its `source`, the same 202 on a repeat, then
 *     confirm → unsubscribe → rejoin on the closed host.
 *
 * The last one writes to the real database and sends two real mails (Resend's
 * deliverable test address), so it skips without its credentials. The browser's
 * waitlist POSTs carry a fresh `CF-Connecting-IP` (`drillIp`) so the per-IP
 * limit is per test. Turnstile runs on Cloudflare's test keys.
 */

config({ path: ".env.local", quiet: true });

const SKIP_DB =
  process.env.DATABASE_URL && process.env.RESEND_API_KEY && process.env.EMAIL_FROM
    ? false
    : "DATABASE_URL / RESEND_API_KEY / EMAIL_FROM absent — run locally with apps/web/.env.local";

/** One tile face per engine phase; the engine crossfades them by opacity. */
const face = (page: Page, name: "idle" | "error") => page.locator(`[data-face="${name}"]`);
const dialog = (page: Page) => page.getByTestId("waitlist-dialog");

const PAGE = "<!doctype html><html><head><title>waitlist e2e</title></head><body><h1>hi</h1></body></html>";

/** Count every request to the publish route this page makes, without touching it. */
function countPublishes(page: Page): () => number {
  let count = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/publish") count += 1;
  });
  return () => count;
}

/** Give the browser's waitlist POSTs a client address of their own. */
async function asClient(page: Page) {
  const ip = drillIp();
  await page.route("**/api/waitlist**", (route) =>
    route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": ip } }),
  );
}

/** Turnstile's test widget has handed the form its token. */
async function verified(page: Page) {
  await expect(page.locator('input[name="cf-turnstile-response"]')).toHaveValue(/.+/, {
    timeout: 15_000,
  });
}

async function openLanding(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
}

test.describe("closed deploy — the waitlist", () => {
  test.skip(keptOpen(), "the harness is open — run `pnpm test:e2e:closed` for this file");

  test.beforeAll(async ({ request }) => {
    // `reuseExistingServer` would happily adopt an OPEN server on :3000, and
    // every assertion below would then fail for the wrong reason.
    const health = await request.get("/api/health");
    expect(health.status()).toBe(200);
    expect(
      ((await health.json()) as { open: boolean }).open,
      "the server on :3000 is open — stop it and rerun test:e2e:closed",
    ).toBe(false);
  });

  test("a chosen page opens the waitlist and publishes nothing", async ({ page }) => {
    const publishes = countPublishes(page);
    await openLanding(page);

    await page.setInputFiles('input[type="file"]', {
      name: "hello.html",
      mimeType: "text/html",
      buffer: Buffer.from(PAGE),
    });

    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText("kept isn’t open yet");
    // The tile went back to the drop box behind the dialog.
    await expect(face(page, "idle")).toHaveCSS("opacity", "1");
    await expect(face(page, "error")).toHaveCSS("opacity", "0");
    expect(publishes()).toBe(0);
  });

  test("a pasted page opens it too", async ({ page }) => {
    const publishes = countPublishes(page);
    await openLanding(page);

    await page.evaluate((markup) => {
      const data = new DataTransfer();
      data.setData("text/plain", markup);
      document.body.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, PAGE);

    await expect(dialog(page)).toBeVisible();
    expect(publishes()).toBe(0);
  });

  test("a file that is not a page gets the drop box's refusal, not the waitlist", async ({ page }) => {
    await openLanding(page);

    await page.setInputFiles('input[type="file"]', {
      name: "photo.png",
      mimeType: "image/png",
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });

    await expect(face(page, "error")).toHaveCSS("opacity", "1");
    await expect(dialog(page)).toHaveCount(0);
  });

  test("the nav offers the waitlist where sign-in was", async ({ page }) => {
    await openLanding(page);

    await expect(page.locator("#nav-signin")).toHaveCount(0);
    await page.locator("#nav-waitlist").click();
    await expect(dialog(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
  });

  test("an address the server refuses is said so in the dialog", async ({ page }) => {
    // The route rate-limits in Postgres before it validates the address.
    test.skip(!!SKIP_DB, String(SKIP_DB));
    await asClient(page);
    await openLanding(page);
    await page.locator("#nav-waitlist").click();
    await expect(dialog(page).getByTestId("consent-line")).toContainText("Unsubscribe anytime in one click.");
    await verified(page);

    // Passes the browser's own `type=email` check, fails the server's.
    await dialog(page).getByRole("textbox").fill("ada@example");
    await dialog(page).getByRole("button", { name: "Join the waitlist" }).click();

    await expect(page.getByTestId("email-form-error")).toHaveText("Enter a valid email address.");
  });

  test("the control-plane pages stay reachable; a page no rule allows lands on the landing", async ({
    page,
  }) => {
    test.skip(!process.env.NEXT_PUBLIC_APP_URL, "NEXT_PUBLIC_APP_URL absent — nothing to route to");
    // The gate reads the session through Better Auth.
    const skip = skipAuth();
    test.skip(!!skip, skip || undefined);

    // Signed out, `/auth` is the sign-in screen and the gated pages bounce to it.
    for (const path of ["/auth", "/dashboard", "/settings"]) {
      await page.goto(path);
      expect(new URL(page.url()).pathname, path).toBe("/auth");
    }

    const response = await page.goto("/no-such-page");
    expect(response?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe("/");
    await expect(page.locator("#nav-waitlist")).toBeVisible();
  });

  test.describe("joining, against the real database", () => {
    test.skip(!!SKIP_DB, String(SKIP_DB));
    test.setTimeout(LIVE_STACK_TIMEOUT);

    const email = `delivered+wl-closed-${crypto.randomUUID().slice(0, 8)}@resend.dev`;

    test.beforeAll(warmDb);
    test.afterAll(async () => {
      await db.delete(waitlist).where(eq(waitlist.email, email));
      await closeDb();
    });

    test("join → confirm → unsubscribe → rejoin, all on the closed deploy", async ({
      page,
      request,
    }) => {
      await asClient(page);
      await openLanding(page);
      await page.locator("#nav-waitlist").click();
      await verified(page);
      await dialog(page).getByRole("textbox").fill(`  ${email.toUpperCase()} `);
      await dialog(page).getByRole("button", { name: "Join the waitlist" }).click();

      await expect(dialog(page)).toContainText(
        "Check your inbox and click the link to confirm. Nothing else arrives until you do.",
      );
      const pending = await db.select().from(waitlist).where(eq(waitlist.email, email));
      expect(pending).toHaveLength(1);
      expect(pending[0]?.source).toBe("landing_nav");
      expect(pending[0]?.confirmedAt).toBeNull();

      // Same inbox, other spelling, inside the cooldown: the same 202, one row, no send.
      const again = await request.post("/api/waitlist", {
        headers: { "cf-connecting-ip": drillIp() },
        data: { email, source: "landing_drop", turnstileToken: TURNSTILE_TEST_KEYS.dummyToken },
      });
      expect(again.status()).toBe(202);
      expect(await again.json()).toEqual({ status: "check_inbox" });
      const still = await db.select().from(waitlist).where(eq(waitlist.email, email));
      expect(still).toHaveLength(1);
      expect(still[0]?.confirmSendCount).toBe(1);

      // Confirm: the raw token lives only in the mail, so put one of our own on the row.
      const token = generateAnonToken();
      await db.update(waitlist).set({ confirmTokenHash: await hashToken(token) }).where(eq(waitlist.email, email));
      await page.goto(`/waitlist/confirm?t=${token}`);
      expect(new URL(page.url()).pathname).toBe("/waitlist/confirm");
      await page.getByRole("button", { name: "Confirm my email" }).click();
      await expect(page.getByTestId("confirm-done")).toBeVisible();

      // Unsubscribe through the visible link's page.
      await page.goto(`/waitlist/unsubscribe?t=${encodeURIComponent(unsubscribeToken(email))}`);
      await expect(page.getByRole("heading", { name: "You’re off the list." })).toBeVisible();
      const [off] = await db.select().from(waitlist).where(eq(waitlist.email, email));
      expect(off?.unsubscribedAt).not.toBeNull();

      // Rejoin from that page: double opt-in again.
      await verified(page);
      await page.getByRole("textbox", { name: "Email address" }).fill(email);
      await page.getByRole("button", { name: "Join the waitlist" }).click();
      await expect(page.getByTestId("email-form-success")).toBeVisible();
      const [back] = await db.select().from(waitlist).where(eq(waitlist.email, email));
      expect(back?.unsubscribedAt).toBeNull();
      expect(back?.confirmedAt).toBeNull();
    });
  });
});
