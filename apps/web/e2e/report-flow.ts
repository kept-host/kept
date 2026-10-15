import { expect, test, type Page } from "@playwright/test";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";

import { closeDb, db } from "../lib/db";
import { abuseReports, sites } from "../lib/db/schema";
import { keptOpen } from "../lib/launch";
import { drillIp } from "../lib/testing/drill-ip";
import { NamesDrill } from "../lib/testing/names-drill";
import { TURNSTILE_TEST_KEYS } from "../lib/testing/turnstile";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";

/**
 * Reports over the wire (E07 task 010, AC15), declared once and run on BOTH
 * deploys: `report.spec.ts` (open, plus AC16 and AC17 there) and
 * `report.closed.spec.ts` (closed — `/report` and `POST /api/reports` pass the
 * closed gate, edge case 16). Not a `*.spec.ts`, so Playwright never collects
 * it on its own.
 *
 * NO MOCKS: the real server, dev Neon, Turnstile on Cloudflare's always-pass
 * test keys (set by `playwright.config.ts`), Resend. The pages reported here
 * are real `sites` rows with no bytes (`NamesDrill`), so nothing touches KV.
 * Every request carries a fresh `CF-Connecting-IP` (`drillIp`) so the per-IP
 * limit is per test. Mail: one receipt to a `delivered+…@resend.dev` address
 * and the admin alerts to the harness's per-run admin address.
 */
config({ path: ".env.local", quiet: true });

const REQUIRED = ["DATABASE_URL", "KEPT_BASE_DOMAIN", "RESEND_API_KEY", "EMAIL_FROM"] as const;
const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
export const SKIP_REPORTS: string | false =
  missing.length > 0 ? `report credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local` : false;

export const pageUrl = (slug: string): string => `https://${slug}.${process.env.KEPT_BASE_DOMAIN}`;

/** A valid report body for `link`. */
export function reportBody(link: string, extra: Record<string, unknown> = {}) {
  return {
    url: link,
    category: "scam",
    details: "It promises a refund if I send a deposit first, then disappears.",
    goodFaith: true,
    turnstileToken: TURNSTILE_TEST_KEYS.dummyToken,
    ...extra,
  };
}

/** Give the browser's report POSTs this test's client address. */
async function asClient(page: Page) {
  const ip = drillIp();
  await page.route("**/api/reports", (route) =>
    route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": ip } }),
  );
}

/** Turnstile's test widget has handed the form its token. */
async function verified(page: Page) {
  await expect(page.locator('input[name="cf-turnstile-response"]')).toHaveValue(/.+/, { timeout: 15_000 });
}

/** The reports stored against `siteId`, oldest first. */
export async function reportsFor(siteId: string) {
  return db.select().from(abuseReports).where(eq(abuseReports.siteId, siteId)).orderBy(abuseReports.createdAt);
}

export function reportFlow(mode: "open" | "closed"): void {
  test.describe(`reports (${mode})`, () => {
    test.skip(
      keptOpen() !== (mode === "open"),
      mode === "open" ? "the harness is closed" : "the harness is open — run `pnpm test:e2e:closed`",
    );
    test.skip(!!SKIP_REPORTS, SKIP_REPORTS || undefined);
    test.describe.configure({ timeout: LIVE_STACK_TIMEOUT });

    const drill = new NamesDrill(`e07-010-${mode}`);
    const siteIds: string[] = [];

    /** An anonymous live page with no bytes — a real row the link resolves to. */
    async function livePage() {
      const site = await drill.site({ ownerId: await drill.profile() });
      await db.update(sites).set({ ownerId: null, currentVersionId: null }).where(eq(sites.id, site.id));
      siteIds.push(site.id);
      return site;
    }

    test.beforeAll(async ({ request }) => {
      if (SKIP_REPORTS) return;
      const health = await request.get("/api/health");
      expect(
        ((await health.json()) as { open: boolean }).open,
        `the server on :3000 is not ${mode} — stop it and rerun`,
      ).toBe(mode === "open");
      await warmDb();
    });

    test.afterAll(async () => {
      if (SKIP_REPORTS) return;
      if (siteIds.length > 0) await db.delete(abuseReports).where(inArray(abuseReports.siteId, siteIds));
      await drill.cleanup();
      await closeDb();
    });

    test("the form prefills from ?url=, checks its fields inline and sends a report", async ({ page }) => {
      const site = await livePage();
      const link = pageUrl(site.slug);
      await asClient(page);
      await page.goto(`/report?url=${encodeURIComponent(link)}`);

      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tell us about a page.");
      await expect(page.getByLabel("Link to the page")).toHaveValue(link);

      await verified(page);
      await page.getByRole("button", { name: "Send report" }).click();
      await expect(page.getByTestId("report-category-error")).toHaveText("Choose what's wrong.");
      await expect(page.getByTestId("report-details-error")).toBeVisible();
      await expect(page.getByTestId("report-goodFaith-error")).toBeVisible();
      await expect(page.getByTestId("report-url-error")).toHaveCount(0);

      await page.getByLabel("Child sexual abuse material").check();
      await expect(page.getByTestId("report-csam-note")).toBeVisible();
      await page.getByLabel("Scam or fraud").check();
      await expect(page.getByTestId("report-csam-note")).toHaveCount(0);

      await page.getByLabel("Tell us what you saw").fill(reportBody(link).details);
      await page.getByLabel(/Your email/).fill(`delivered+e07-010-${mode}-${crypto.randomUUID().slice(0, 8)}@resend.dev`);
      await page.getByLabel(/in good faith/).check();
      await page.getByRole("button", { name: "Send report" }).click();

      const sent = page.getByTestId("report-sent");
      await expect(sent).toContainText("Thanks — we’ve got it.");
      await expect(sent).toContainText("We’ll email you what we decide.");

      const [stored] = await reportsFor(site.id);
      expect(stored?.status).toBe("open");
      expect(stored?.category).toBe("scam");
      expect(stored?.reporterName).toBeNull();
      expect(stored?.reporterEmail).toMatch(/@resend\.dev$/);
    });

    test("without an email the sent state promises no mail; a link that isn't kept is refused inline", async ({ page }) => {
      const site = await livePage();
      await asClient(page);
      await page.goto("/report?url=https%3A%2F%2Fexample.com%2Fnot-kept");
      await page.getByLabel("Spam").check();
      await page.getByLabel("Tell us what you saw").fill(reportBody("").details);
      await page.getByLabel(/in good faith/).check();
      await verified(page);
      await page.getByRole("button", { name: "Send report" }).click();
      await expect(page.getByTestId("report-error")).toHaveText("That link isn't a kept page.");

      // A refused submit gets a fresh widget (tokens are single-use), then sends.
      await page.getByLabel("Link to the page").fill(pageUrl(site.slug));
      await verified(page);
      await page.getByRole("button", { name: "Send report" }).click();
      const sent = page.getByTestId("report-sent");
      await expect(sent).toContainText("Thanks — we’ve got it.");
      await expect(sent).not.toContainText("email you");
      expect((await reportsFor(site.id)).map((row) => row.reporterEmail)).toEqual([null]);
    });

    test("the API requires the Turnstile token and the good-faith box, and refuses links that aren't kept", async ({ request }) => {
      const site = await livePage();
      const link = pageUrl(site.slug);
      const headers = { "cf-connecting-ip": drillIp() };

      for (const data of [reportBody(link, { turnstileToken: undefined }), reportBody(link, { goodFaith: false }), reportBody(link, { goodFaith: undefined })]) {
        const refused = await request.post("/api/reports", { data, headers });
        expect(refused.status()).toBe(400);
        expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("invalid");
      }

      const foreign = await request.post("/api/reports", {
        data: reportBody(`https://nope-${crypto.randomUUID().slice(0, 8)}.${process.env.KEPT_BASE_DOMAIN}`),
        headers,
      });
      expect(foreign.status()).toBe(422);
      expect(await foreign.json()).toEqual({
        error: { code: "not_a_kept_page", message: "That link isn't a kept page." },
      });
      expect(await reportsFor(site.id)).toHaveLength(0);

      const ok = await request.post("/api/reports", { data: reportBody(link), headers });
      expect(ok.status()).toBe(201);
      expect(await ok.json()).toEqual({ ok: true });
    });
  });
}
