import { FOUNDING_REVIEW_TTL_DAYS, generateAnonToken, hashToken } from "@kept/shared";
import { expect, test, type Page } from "@playwright/test";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";

import { reviewToken } from "../lib/founding/review-token";
import { closeDb, db } from "../lib/db";
import { waitlist } from "../lib/db/schema";
import { keptOpen } from "../lib/launch";
import { drillIp } from "../lib/testing/drill-ip";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";

/**
 * Founding applications over the wire (E06a §4, task 006), declared once and
 * run on BOTH deploys: `founding.spec.ts` (open) and `founding.closed.spec.ts`
 * (closed — `/founding*` and `/api/founding/review` pass the closed gate).
 * Not a `*.spec.ts`, so Playwright never collects it on its own.
 *
 *   apply on /founding → confirm → admin notice → review GET (no change)
 *   → Approve → approval mail → a second approve is a no-op; Decline; expired.
 *
 * NO MOCKS: real server, dev Neon, Turnstile test keys, Resend. THE BUDGET per
 * run is three sends, all to Resend's deliverable test addresses: the
 * confirmation, the admin notice (to the harness's per-run
 * `KEPT_E2E_ADMIN_EMAIL`, set by `playwright.config.ts` for open and closed),
 * and the approval. There is no inbox credential, so receipt is skipped with
 * that reason; the sends are proven by the state they drive.
 *
 * The raw confirmation token only exists in the mail, so the confirm step puts
 * a token of its own on the row. Review links are signed here with the
 * `KEPT_ADMIN_SECRET` the server inherited from the harness.
 */
config({ path: ".env.local", quiet: true });

const REQUIRED = ["DATABASE_URL", "RESEND_API_KEY", "EMAIL_FROM"] as const;
const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
const SKIP: string | false =
  missing.length > 0
    ? `founding credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local`
    : false;

const DAY_MS = 24 * 60 * 60 * 1000;

async function row(email: string) {
  const [found] = await db.select().from(waitlist).where(eq(waitlist.email, email));
  return found;
}

/** Give the browser's waitlist POSTs this test's client address. */
async function asClient(page: Page) {
  const ip = drillIp();
  await page.route("**/api/waitlist**", (route) =>
    route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": ip } }),
  );
}

export function foundingFlow(mode: "open" | "closed"): void {
  test.describe(`founding applications (${mode})`, () => {
    test.skip(
      keptOpen() !== (mode === "open"),
      mode === "open" ? "the harness is closed" : "the harness is open — run `pnpm test:e2e:closed`",
    );
    test.skip(!!SKIP, SKIP || undefined);
    test.describe.configure({ mode: "serial", timeout: LIVE_STACK_TIMEOUT });

    const label = `${mode}-${crypto.randomUUID().slice(0, 8)}`;
    const applicant = `delivered+founding-${label}@resend.dev`;
    const declined = `founding-e2e-${label}@example.com`;

    test.beforeAll(async ({ request }) => {
      if (SKIP) return;
      const health = await request.get("/api/health");
      expect(
        ((await health.json()) as { open: boolean }).open,
        `the server on :3000 is not ${mode} — stop it and rerun`,
      ).toBe(mode === "open");
      await warmDb();
    });

    test.afterAll(async () => {
      if (SKIP) return;
      await db.delete(waitlist).where(inArray(waitlist.email, [applicant, declined]));
      await closeDb();
    });

    test("AC12: /founding explains the offer and the form files a pending application", async ({ page }) => {
      await asClient(page);
      await page.goto("/founding");
      expect(new URL(page.url()).pathname).toBe("/founding");
      await expect(page.getByRole("heading", { name: "Become a founding creator." })).toBeVisible();
      await expect(page.locator("main")).toContainText(
        "Founding creators get kept Pro free when kept opens in December — including the wall editor, so your page wall looks the way you want. Hand-picked: Arun looks at every application. No posting obligation.",
      );
      await expect(page.getByTestId("consent-line")).toContainText("Unsubscribe anytime in one click.");

      await page.getByRole("textbox", { name: "Email address" }).fill(applicant);
      await page.getByLabel("Your social profile URL").fill("https://example.com/@founding-e2e");
      await page.getByLabel(/What do you make with AI\?/).fill("Picture books");
      await expect(page.getByTestId("note-count")).toHaveText("13/280");
      await expect(page.locator('input[name="cf-turnstile-response"]')).toHaveValue(/.+/, { timeout: 15_000 });
      await page.getByRole("button", { name: "Apply" }).click();
      await expect(page.getByTestId("email-form-success")).toHaveText(
        "Check your inbox to confirm your email. Then your application goes to Arun.",
      );

      const pending = await row(applicant);
      console.log(
        `[founding-e2e] applied: source=${pending?.source} status=${pending?.foundingStatus} sends=${pending?.confirmSendCount}`,
      );
      expect(pending?.source).toBe("founding");
      expect(pending?.foundingStatus).toBe("pending");
      expect(pending?.socialUrl).toBe("https://example.com/@founding-e2e");
      expect(pending?.note).toBe("Picture books");
      expect(pending?.confirmSendCount, "double opt-in: one confirmation").toBe(1);
      expect(pending?.confirmedAt).toBeNull();
    });

    test("AC12: confirming sends the application to Arun and says so", async ({ page }) => {
      const token = generateAnonToken();
      await db
        .update(waitlist)
        .set({ confirmTokenHash: await hashToken(token) })
        .where(eq(waitlist.email, applicant));

      await page.goto(`/waitlist/confirm?t=${token}`);
      await page.getByRole("button", { name: "Confirm my email" }).click();
      await expect(page.getByTestId("confirm-done")).toHaveText(
        "You’re on the list, and your founding application is with Arun. You’ll hear back by email.",
      );
      expect((await row(applicant))?.confirmedAt).not.toBeNull();
    });

    test("AC12: the admin notice and the approval mail arrive", async () => {
      test.skip(true, "no inbox credential: Resend's test addresses accept the send but cannot be read back");
    });

    test("AC13: the review GET shows the card and changes nothing; Approve approves; a second approve is a no-op", async ({
      page,
      request,
    }) => {
      const t = reviewToken(applicant);
      await page.goto(`/founding/review?t=${encodeURIComponent(t)}`);
      expect(new URL(page.url()).pathname).toBe("/founding/review");
      const card = page.getByTestId("applicant-card");
      await expect(card).toContainText(applicant);
      await expect(card.getByRole("link", { name: "https://example.com/@founding-e2e" })).toHaveAttribute(
        "href",
        "https://example.com/@founding-e2e",
      );
      await expect(card).toContainText("Picture books");
      const untouched = await row(applicant);
      expect(untouched?.foundingStatus, "a GET never decides").toBe("pending");
      expect(untouched?.foundingDecidedAt).toBeNull();

      await page.getByRole("button", { name: "Approve" }).click();
      await expect(page.getByTestId("review-done")).toHaveText("Approved, the creator has been emailed");
      const approved = await row(applicant);
      expect(approved?.foundingStatus).toBe("approved");
      expect(approved?.foundingDecidedAt).not.toBeNull();

      const again = await request.post("/api/founding/review", { data: { t, decision: "approve" } });
      expect(again.status()).toBe(200);
      expect(await again.json()).toEqual({ status: "approved", emailed: false });
      expect((await row(applicant))?.foundingDecidedAt).toEqual(approved?.foundingDecidedAt);
    });

    test("AC13: Decline declines and mails nobody", async ({ page }) => {
      await db.insert(waitlist).values({
        email: declined,
        source: "founding",
        confirmedAt: new Date(),
        foundingStatus: "pending",
        socialUrl: "https://example.com/@declined",
      });
      await page.goto(`/founding/review?t=${encodeURIComponent(reviewToken(declined))}`);
      await page.getByRole("button", { name: "Decline" }).click();
      await expect(page.getByTestId("review-done")).toHaveText("Declined");
      const after = await row(declined);
      expect(after?.foundingStatus).toBe("declined");
      expect(after?.unsubscribedAt, "they stay on the waitlist").toBeNull();
    });

    test("AC13: an expired or tampered link is 410 and the page points at admin:founding add", async ({
      page,
      request,
    }) => {
      const stale = reviewToken(declined, new Date(Date.now() - (FOUNDING_REVIEW_TTL_DAYS + 1) * DAY_MS));
      for (const t of [stale, `${reviewToken(declined)}x`]) {
        const response = await request.post("/api/founding/review", { data: { t, decision: "approve" } });
        expect(response.status()).toBe(410);
      }
      expect((await row(declined))?.foundingStatus, "neither changed anything").toBe("declined");

      await page.goto(`/founding/review?t=${encodeURIComponent(stale)}`);
      await expect(page.getByTestId("review-expired")).toContainText("Use admin:founding add instead.");
      await expect(page.getByTestId("applicant-card")).toHaveCount(0);
    });
  });
}
