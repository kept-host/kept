import { KEPT_PAGE_LIMIT, WAITLIST_CONSENT_TEXT } from "@kept/shared";
import { test, expect, type Page } from "@playwright/test";
import { config } from "dotenv";
import { inArray } from "drizzle-orm";

import { closeDb, db } from "../lib/db";
import { waitlist } from "../lib/db/schema";
import { keptOpen } from "../lib/launch";
import { drillIp } from "../lib/testing/drill-ip";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";

/**
 * The CLOSED landing's copy and forms (E06a §7, AC20/AC21). Run with
 *
 *   pnpm --filter @kept/web test:e2e:closed
 *
 * Copy: only true things — one framing line under the hero, no SOON pills, no
 * zero counters, no kept-page number, no price, no Pro feature but the wall
 * editor; the founding card links to `/founding`; the footer carries
 * Impressum · Privacy · GitHub.
 *
 * Forms: every email field on the apex is the shared waitlist form and stores
 * a row with its own `source` — asserted in the real database, one join per
 * door. Each join sends one real confirmation mail to Resend's deliverable
 * test address, so that part skips without its credentials. The nav door is
 * also covered by `waitlist.closed.spec.ts`; it is repeated here so AC21's
 * three sources are asserted side by side.
 */

config({ path: ".env.local", quiet: true });

const SKIP_DB =
  process.env.DATABASE_URL && process.env.RESEND_API_KEY && process.env.EMAIL_FROM
    ? false
    : "DATABASE_URL / RESEND_API_KEY / EMAIL_FROM absent — run locally with apps/web/.env.local";

const PAGE = "<!doctype html><html><head><title>landing forms e2e</title></head><body><h1>hi</h1></body></html>";

const dialog = (page: Page) => page.getByTestId("waitlist-dialog");

async function openLanding(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
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

/** Join through whichever door has opened the dialog, and see "check your inbox". */
async function joinThroughDialog(page: Page, email: string) {
  await expect(dialog(page).getByTestId("consent-line")).toBeVisible();
  await verified(page);
  await dialog(page).getByRole("textbox").fill(email);
  await dialog(page).getByRole("button", { name: "Join the waitlist" }).click();
  await expect(dialog(page)).toContainText("Check your inbox and click the link to confirm.");
}

test.describe("closed landing — copy and forms", () => {
  test.skip(keptOpen(), "the harness is open — run `pnpm test:e2e:closed` for this file");

  test.beforeAll(async ({ request }) => {
    const health = await request.get("/api/health");
    expect(health.status()).toBe(200);
    expect(
      ((await health.json()) as { open: boolean }).open,
      "the server on :3000 is open — stop it and rerun test:e2e:closed",
    ).toBe(false);
  });

  test("AC20: one framing line, no pills, counters, page number, price or Pro list", async ({ page }) => {
    await openLanding(page);

    await expect(page.getByTestId("launch-framing")).toHaveText(
      /kept opens in December — everything on this page works from that day\./,
    );

    // The served markup, collapsed accordion bodies included.
    const html = await page.content();
    const text = await page.locator("body").evaluate((el) => (el as HTMLElement).innerText);
    expect(html).not.toMatch(/\bSOON\b|COMING SOON|· soon/);
    expect(text).not.toMatch(/\bCOMING\b/);
    expect(text, "a kept-page number").not.toMatch(new RegExp(`\\b${KEPT_PAGE_LIMIT}\\s+pages`));
    expect(text, "a page figure").not.toMatch(/\d+\s+pages?\s+kept/i);
    expect(text, "a price").not.toMatch(/€\s?\d|\$\d|per month|\/mo\b/i);
    expect(html).not.toMatch(
      /Notify me about Pro|Pro is what keeps|Power path|EU data residency|Custom domains|Password-protected|Private analytics|Remove the kept badge/,
    );

    // No zero counters: nav, intro loader, open-books figures.
    await expect(page.locator('[title="pages kept forever, right now"]')).toHaveCount(0);
    expect(text).not.toMatch(/PAGES KEPT|infra cost this month|uptime ·/);
    await expect(page.locator("#gauge-card")).toBeVisible();

    // The Pro card is the founding card; the wall editor is the one Pro feature.
    const pricing = page.locator("#pricing");
    await expect(pricing.getByRole("heading", { name: "Become a founding creator" })).toBeVisible();
    await expect(pricing.getByText(/including the wall editor/)).toHaveCount(1);
    await expect(
      pricing.getByRole("link", { name: /Apply to be a founding creator/ }),
    ).toHaveAttribute("href", "/founding");

    // Open source / AGPL point at the repo; footer reads Impressum · Privacy · GitHub.
    const repo = "https://github.com/kept-host/kept";
    await expect(page.locator("#nav-links").getByRole("link", { name: /OPEN\s*SOURCE/ })).toHaveAttribute(
      "href",
      repo,
    );
    await expect(page.locator("#why").getByRole("link", { name: "OPEN SOURCE · AGPL" })).toHaveAttribute(
      "href",
      repo,
    );
    await expect(page.locator("#why")).toContainText("AGPL — you can run it yourself.");
    const footer = page.locator("footer");
    for (const name of ["Impressum", "Privacy", "GitHub"]) {
      await expect(footer.getByRole("link", { name, exact: true })).toBeVisible();
    }
  });

  test("AC21: each door opens the shared form with the consent line and its own pitch", async ({ page }) => {
    await openLanding(page);

    // Get notified — the agents section's door.
    await page.locator("#agents").getByRole("button", { name: "Get notified" }).click();
    await expect(dialog(page)).toContainText("Get notified");
    await expect(dialog(page).getByTestId("consent-line")).toContainText(
      WAITLIST_CONSENT_TEXT.split("[")[0]!.trim(),
    );
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);

    // A chosen page — the drop door.
    await page.setInputFiles('input[type="file"]', {
      name: "hello.html",
      mimeType: "text/html",
      buffer: Buffer.from(PAGE),
    });
    await expect(dialog(page)).toContainText(
      "Your page will publish the moment kept opens in December. Get the email.",
    );
    await expect(dialog(page).getByTestId("consent-line")).toBeVisible();
  });

  test.describe("a row per door, against the real database", () => {
    test.skip(!!SKIP_DB, String(SKIP_DB));
    test.setTimeout(LIVE_STACK_TIMEOUT);

    const run = crypto.randomUUID().slice(0, 8);
    const emails = {
      landing_drop: `delivered+lf-drop-${run}@resend.dev`,
      landing_nav: `delivered+lf-nav-${run}@resend.dev`,
      landing_notify: `delivered+lf-notify-${run}@resend.dev`,
    } as const;

    test.beforeAll(warmDb);
    test.afterAll(async () => {
      await db.delete(waitlist).where(inArray(waitlist.email, Object.values(emails)));
      await closeDb();
    });

    async function expectRow(email: string, source: keyof typeof emails) {
      const rows = await db.select().from(waitlist).where(inArray(waitlist.email, [email]));
      expect(rows, `one row for ${source}`).toHaveLength(1);
      expect(rows[0]?.source).toBe(source);
      expect(rows[0]?.confirmedAt).toBeNull();
    }

    test("drop → landing_drop", async ({ page }) => {
      await asClient(page);
      await openLanding(page);
      await page.setInputFiles('input[type="file"]', {
        name: "hello.html",
        mimeType: "text/html",
        buffer: Buffer.from(PAGE),
      });
      await joinThroughDialog(page, emails.landing_drop);
      await expectRow(emails.landing_drop, "landing_drop");
    });

    test("nav JOIN WAITLIST → landing_nav", async ({ page }) => {
      await asClient(page);
      await openLanding(page);
      await page.locator("#nav-waitlist").click();
      await joinThroughDialog(page, emails.landing_nav);
      await expectRow(emails.landing_nav, "landing_nav");
    });

    test("Get notified → landing_notify", async ({ page }) => {
      await asClient(page);
      await openLanding(page);
      await page.locator("#agents").getByRole("button", { name: "Get notified" }).click();
      await joinThroughDialog(page, emails.landing_notify);
      await expectRow(emails.landing_notify, "landing_notify");
    });
  });
});
