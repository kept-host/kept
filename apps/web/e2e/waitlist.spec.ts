import { test, expect, type Page } from "@playwright/test";
import { config } from "dotenv";
import { eq } from "drizzle-orm";

import { closeDb, db } from "../lib/db";
import { waitlist } from "../lib/db/schema";
import { keptOpen } from "../lib/launch";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";

/**
 * A CLOSED deploy — the waitlist (`lib/launch.ts`). Run with
 *
 *   pnpm --filter @kept/web test:e2e:closed
 *
 * which boots the server with `NEXT_PUBLIC_KEPT_OPEN=false`. The ordinary
 * `test:e2e` run is open (see `playwright.config.ts`) and skips this file.
 *
 * What a closed deploy promises, each asserted against the real server:
 *   - a valid page dropped, chosen or pasted opens the waitlist and sends
 *     NOTHING to `/api/publish` — counted off the wire, not intercepted;
 *   - a file that is not a page still gets the drop box's own refusal;
 *   - the nav offers the waitlist where sign-in was;
 *   - every control-plane page lands on the landing, and every API but health
 *     and the waitlist is 404 — sign-in included, with no cookie;
 *   - joining stores one lowercased row, and joining again stores no second.
 *
 * The last one writes to the real database, so it skips without
 * `DATABASE_URL`, like every live spec here.
 */

config({ path: ".env.local", quiet: true });

const SKIP_DB = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

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
    await openLanding(page);
    await page.locator("#nav-waitlist").click();

    // Passes the browser's own `type=email` check, fails the server's.
    await dialog(page).getByRole("textbox").fill("ada@example");
    await dialog(page).getByRole("button", { name: "Join the waitlist" }).click();

    await expect(page.getByTestId("waitlist-error")).toHaveText("Enter a valid email address.");
  });

  test("every control-plane page lands on the landing", async ({ page }) => {
    for (const path of ["/auth", "/auth/keep", "/dashboard", "/settings", "/keep/tok_e2e", "/p/tok_e2e"]) {
      const response = await page.goto(path);
      if (process.env.NEXT_PUBLIC_APP_URL) {
        expect(new URL(page.url()).pathname, path).toBe("/");
        await expect(page.locator("#nav-waitlist"), path).toBeVisible();
      } else {
        // Nowhere configured to send anyone: 404, never a redirect built from
        // the request (`decideClosedAction`).
        expect(response?.status(), path).toBe(404);
      }
    }
  });

  test("every API but health and the waitlist is 404 — sign-in included, with no cookie", async ({
    request,
  }) => {
    const refused = [
      request.post("/api/publish", { headers: { "content-type": "text/html" }, data: PAGE }),
      request.get("/api/auth/get-session"),
      request.post("/api/auth/sign-in/magic-link", { data: { email: "ada@example.com" } }),
      request.post("/api/sites", { data: { html: PAGE } }),
      request.post("/api/anon/tok_e2e/keep"),
      request.get("/api/export"),
    ];
    for (const response of await Promise.all(refused)) {
      expect(response.status(), response.url()).toBe(404);
      expect(response.headers()["set-cookie"], response.url()).toBeUndefined();
    }
  });

  test.describe("joining, against the real database", () => {
    test.skip(!!SKIP_DB, String(SKIP_DB));
    test.setTimeout(LIVE_STACK_TIMEOUT);

    const email = `waitlist-e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;

    test.beforeAll(warmDb);
    test.afterAll(async () => {
      await db.delete(waitlist).where(eq(waitlist.email, email));
      await closeDb();
    });

    test("joining stores one lowercased row, and joining again stores no second", async ({
      page,
      request,
    }) => {
      await openLanding(page);
      await page.locator("#nav-waitlist").click();
      await dialog(page).getByRole("textbox").fill(`  ${email.toUpperCase()} `);
      await dialog(page).getByRole("button", { name: "Join the waitlist" }).click();

      await expect(dialog(page)).toContainText("You’re on the list.");
      expect(await db.select().from(waitlist).where(eq(waitlist.email, email))).toHaveLength(1);

      // Same inbox, other spelling: the same answer, and still one row.
      const again = await request.post("/api/waitlist", { data: { email } });
      expect(again.status()).toBe(200);
      expect(await again.json()).toEqual({ ok: true });
      expect(await db.select().from(waitlist).where(eq(waitlist.email, email))).toHaveLength(1);
    });
  });
});
