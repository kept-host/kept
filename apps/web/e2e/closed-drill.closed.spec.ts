import { generateAnonToken, hashToken } from "@kept/shared";
import { test, expect } from "@playwright/test";
import { config } from "dotenv";
import { eq } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { waitlist } from "../lib/db/schema";
import { reviewToken } from "../lib/founding/review-token";
import { keptOpen } from "../lib/launch";
import { LEGAL_DOCS } from "../lib/legal/links";
import { drillIp } from "../lib/testing/drill-ip";
import { TURNSTILE_TEST_KEYS } from "../lib/testing/turnstile";

import { pageHtml, publishViaApi } from "./live-publish";
import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { cleanup, newScope, signInAs, SKIP_OWNER_UI } from "./owner-fixtures";

/**
 * The closed deploy, end to end — E06a task 010's cross-cutting drill. Run with
 *
 *   pnpm --filter @kept/web test:e2e:closed
 *
 * One story through every closed-mode rule, in order, against the real stack
 * (dev Neon, R2, KV, Resend to `@resend.dev` test addresses, Turnstile's
 * always-pass test keys):
 *
 *   a stranger's sign-in is refused (no user, no mail) → a founding applicant
 *   joins → confirms → Arun is mailed → Arun approves (the approval mail) →
 *   the access token publishes → an admin keeps that page via its claim link →
 *   the cron answers 401 → the legal pages serve and `/impressum` is a 308.
 *
 * The per-rule detail lives in the focused specs (`closed-access`,
 * `admin-sign-in`, `waitlist`, `founding`, `landing-forms`); this file proves
 * the rules hold TOGETHER. It signs in as `KEPT_E2E_DRILL_ADMIN_EMAIL`, the
 * harness's second admin, so its cleanup never touches the admin
 * `admin-sign-in.closed.spec.ts` is using. Mail budget: three sends
 * (confirmation, admin notice, approval). KV budget: one publish, one keep,
 * one takedown.
 */

config({ path: ".env.local", quiet: true });

const MAIL_VARS = ["DATABASE_URL", "RESEND_API_KEY", "EMAIL_FROM"] as const;
const missingMail = MAIL_VARS.filter((name) => !process.env[name]?.trim());
const SKIP_MAIL: string | false =
  missingMail.length > 0 ? `mail credentials absent (${missingMail.join(", ")})` : false;

const runId = crypto.randomUUID().slice(0, 8);
const stranger = `stranger-drill-${runId}@kept-e06a-010.invalid`;
const applicant = `delivered+drill-${runId}@resend.dev`;

test.describe("closed deploy — the whole story", () => {
  test.skip(keptOpen(), "the harness is open — run `pnpm test:e2e:closed` for this file");
  test.describe.configure({ mode: "serial", timeout: LIVE_STACK_TIMEOUT });

  const scope = newScope();

  test.beforeAll(async ({ request }) => {
    const health = await request.get("/api/health");
    expect(
      ((await health.json()) as { open: boolean }).open,
      "the server on :3000 is open — stop it and rerun test:e2e:closed",
    ).toBe(false);
    if (!SKIP_MAIL) await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_MAIL) return;
    await cleanup(scope);
    await db.delete(waitlist).where(eq(waitlist.email, applicant));
    await closeDb();
  });

  test("a stranger's magic link is refused: the neutral 200, no user", async ({ request }) => {
    test.skip(!!SKIP_MAIL, SKIP_MAIL || undefined);
    const response = await request.post("/api/auth/sign-in/magic-link", {
      headers: { "cf-connecting-ip": drillIp() },
      data: { email: stranger, callbackURL: "/dashboard" },
    });
    expect(response.status(), await response.text()).toBe(200);
    expect(await response.json()).toEqual({ status: true });
    expect(response.headers()["set-cookie"]).toBeUndefined();
    const users = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, stranger));
    expect(users).toEqual([]);
  });

  test("a founding applicant joins, confirms, and is approved", async ({ request }) => {
    test.skip(!!SKIP_MAIL, SKIP_MAIL || undefined);

    const joined = await request.post("/api/waitlist", {
      headers: { "cf-connecting-ip": drillIp() },
      data: {
        email: applicant,
        source: "founding",
        turnstileToken: TURNSTILE_TEST_KEYS.dummyToken,
        founding: { socialUrl: "https://example.com/@drill", note: "E06a closed drill" },
      },
    });
    expect(joined.status(), await joined.text()).toBe(202);
    const [pending] = await db.select().from(waitlist).where(eq(waitlist.email, applicant));
    expect(pending?.foundingStatus).toBe("pending");
    expect(pending?.confirmSendCount, "one confirmation mail").toBe(1);

    // The raw confirmation token exists only in the mail; put one of our own on the row.
    const token = generateAnonToken();
    await db
      .update(waitlist)
      .set({ confirmTokenHash: await hashToken(token) })
      .where(eq(waitlist.email, applicant));
    const confirmed = await request.post("/api/waitlist/confirm", { data: { token } });
    expect(confirmed.status(), await confirmed.text()).toBe(200);
    expect(((await confirmed.json()) as { founding: boolean }).founding).toBe(true);

    // Confirming mailed Arun the review link; it is signed with the harness's secret.
    const approved = await request.post("/api/founding/review", {
      data: { t: reviewToken(applicant), decision: "approve" },
    });
    expect(approved.status(), await approved.text()).toBe(200);
    expect(await approved.json()).toEqual({ status: "approved", emailed: true });
    const [row] = await db.select().from(waitlist).where(eq(waitlist.email, applicant));
    expect(row?.confirmedAt).not.toBeNull();
    expect(row?.foundingStatus).toBe("approved");
  });

  test("the admin notice and approval mail arrive", () => {
    test.skip(true, "no inbox credential: Resend's test addresses accept the send but cannot be read back");
  });

  test("the access token publishes, and an admin keeps the page via its claim link", async ({
    page,
    baseURL,
  }) => {
    test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
    const admin = process.env.KEPT_E2E_DRILL_ADMIN_EMAIL;
    expect(admin, "playwright.config.ts sets KEPT_E2E_DRILL_ADMIN_EMAIL").toBeTruthy();

    const published = await publishViaApi(page.request, pageHtml(`closed-drill-${runId}`), {
      authorization: `Bearer ${process.env.KEPT_E2E_ACCESS_TOKEN}`,
    });
    expect(published.status(), await published.text()).toBe(201);
    const { claim_url, slug } = (await published.json()) as { claim_url: string; slug: string };
    scope.slugs.add(slug);

    const { userId } = await signInAs(page, baseURL!, scope, admin);
    await page.goto(new URL(claim_url).pathname);
    await page.getByRole("button", { name: "Keep it forever" }).click();
    await expect(page.getByRole("heading", { name: "Kept forever" })).toBeVisible({
      timeout: LIVE_STACK_TIMEOUT,
    });

    const [kept] = await db
      .select({ ownerId: schema.sites.ownerId, expiresAt: schema.sites.expiresAt })
      .from(schema.sites)
      .where(eq(schema.sites.slug, slug));
    expect(kept?.ownerId).toBe(userId);
    expect(kept?.expiresAt, "kept means no clock").toBeNull();
  });

  test("the cron answers 401 without its secret, and the legal pages serve", async ({ request }) => {
    expect((await request.post("/api/cron/draft-reminder")).status()).toBe(401);

    for (const doc of LEGAL_DOCS) {
      const response = await request.get(`/legal/${doc}`);
      expect(response.status(), doc).toBe(200);
    }
    const moved = await request.get("/impressum", { maxRedirects: 0 });
    expect(moved.status()).toBe(308);
    expect(new URL(moved.headers()["location"]!, "https://x").pathname).toBe("/legal/impressum");
  });
});
