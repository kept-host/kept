import { generateAnonToken, hashToken } from "@kept/shared";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";

import { closeDb, db } from "../lib/db";
import { waitlist } from "../lib/db/schema";
import { drillIp } from "../lib/testing/drill-ip";
import { TURNSTILE_TEST_KEYS } from "../lib/testing/turnstile";
import { unsubscribeToken } from "../lib/waitlist/unsubscribe";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";

/**
 * The waitlist's double opt-in over the wire (E06a §3, task 005) —
 * join → confirm → unsubscribe → rejoin, on an OPEN server (the routes and pages
 * answer the same open and closed; the closed dialog is `waitlist.closed.spec`).
 *
 * NO MOCKS: real server, real dev Neon, real Turnstile siteverify (Cloudflare's
 * test keys, set by `playwright.config.ts`), real Resend. THE BUDGET is two
 * sends, both to Resend's always-deliverable address with a per-run label:
 * the first join and the rejoin. Everything else is arranged to send nothing.
 *
 * The raw confirmation token only ever exists in the mail, and there is no
 * inbox credential to read it back — so the mail-receipt assertion is skipped
 * with that reason, and the confirm drill puts a token of its own on the row
 * (its digest, as the join would) to click through.
 *
 * Every request carries a fresh `CF-Connecting-IP` from the documentation
 * range (`drillIp`), so the per-IP limit (5 an hour) is per test, not shared by
 * every run on this machine. The browser's own POSTs get it on the way out.
 */
config({ path: ".env.local", quiet: true });

const REQUIRED = ["DATABASE_URL", "RESEND_API_KEY", "EMAIL_FROM", "CRON_SECRET"] as const;
const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
const SKIP: string | false =
  missing.length > 0
    ? `waitlist credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local`
    : false;

const runLabel = crypto.randomUUID().slice(0, 8);
const deliverable = (n: number) => `delivered+wl-${runLabel}-${n}@resend.dev`;

const CHECK_INBOX = { status: "check_inbox" };
const CHECK_INBOX_TEXT =
  "Check your inbox and click the link to confirm. Nothing else arrives until you do.";

async function row(email: string) {
  const [found] = await db.select().from(waitlist).where(eq(waitlist.email, email));
  return found;
}

function join(request: APIRequestContext, ip: string, data: Record<string, unknown>) {
  return request.post("/api/waitlist", { headers: { "cf-connecting-ip": ip }, data });
}

/** Status, body and every header but the clock: what "identical" means for AC9. */
async function fingerprint(response: Awaited<ReturnType<APIRequestContext["post"]>>) {
  const headers = { ...response.headers() };
  delete headers.date;
  return { status: response.status(), headers, body: await response.text() };
}

/** Give the browser's waitlist POSTs this test's client address. */
async function asClient(page: Page, ip: string) {
  await page.route("**/api/waitlist**", (route) =>
    route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": ip } }),
  );
}

test.describe("waitlist double opt-in", () => {
  test.skip(!!SKIP, SKIP || undefined);
  test.describe.configure({ mode: "serial", timeout: LIVE_STACK_TIMEOUT });

  const emails = [deliverable(1), deliverable(2)];

  test.beforeAll(async () => {
    if (SKIP) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP) return;
    await db.delete(waitlist).where(inArray(waitlist.email, emails));
    await closeDb();
  });

  test("AC8/AC9: a join is 202 check_inbox and a pending row; a repeat is the identical 202", async ({
    request,
  }) => {
    const email = emails[0]!;
    const ip = drillIp();
    const body = { email, source: "landing_nav", turnstileToken: TURNSTILE_TEST_KEYS.dummyToken };

    const first = await join(request, ip, body);
    expect(first.status()).toBe(202);
    expect(await first.json()).toEqual(CHECK_INBOX);

    const pending = await row(email);
    console.log(`[waitlist-e2e] pending row: source=${pending?.source} sends=${pending?.confirmSendCount}`);
    expect(pending?.source).toBe("landing_nav");
    expect(pending?.confirmTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pending?.confirmSendCount).toBe(1);
    expect(pending?.confirmedAt).toBeNull();

    // Inside the cooldown: no mail, and nothing to tell the two apart.
    const again = await join(request, ip, body);
    expect(await fingerprint(again)).toEqual(await fingerprint(first));
    expect((await row(email))?.confirmSendCount).toBe(1);
  });

  test("AC8: the confirmation mail arrives", async () => {
    test.skip(true, "no inbox credential: Resend's test address accepts the send but cannot be read back");
  });

  test("AC17/AC16: no Turnstile token is 400 with nothing stored; the 6th request in an hour is 429", async ({
    request,
  }) => {
    const ip = drillIp();
    const stranger = `waitlist-e2e-${runLabel}@example.com`;
    for (let i = 1; i <= 5; i += 1) {
      const refused = await join(request, ip, { email: stranger, source: "landing_nav" });
      expect(refused.status(), `request ${i}`).toBe(400);
    }
    expect(await row(stranger)).toBeUndefined();

    const sixth = await join(request, ip, { email: stranger, source: "landing_nav" });
    expect(sixth.status()).toBe(429);
    expect(Number(sixth.headers()["retry-after"])).toBeGreaterThan(0);
    expect((await sixth.json()).message).toBe("Too many tries, try again in a bit.");
  });

  test("AC10: GET shows the button and changes nothing; the button confirms; a reused token is 410 with the rejoin form", async ({
    page,
    request,
  }) => {
    const email = emails[0]!;
    const token = generateAnonToken();
    await db
      .update(waitlist)
      .set({ confirmTokenHash: await hashToken(token) })
      .where(eq(waitlist.email, email));

    await page.goto(`/waitlist/confirm?t=${token}`);
    await expect(page.getByRole("button", { name: "Confirm my email" })).toBeVisible();
    const untouched = await row(email);
    expect(untouched?.confirmedAt, "a GET never confirms").toBeNull();
    expect(untouched?.confirmTokenHash).toBe(await hashToken(token));

    await page.getByRole("button", { name: "Confirm my email" }).click();
    await expect(page.getByTestId("confirm-done")).toHaveText(
      "You’re on the list. We’ll email you when kept opens.",
    );
    const confirmed = await row(email);
    expect(confirmed?.confirmedAt).not.toBeNull();
    expect(confirmed?.confirmTokenHash).toBeNull();

    const reused = await request.post("/api/waitlist/confirm", { data: { token } });
    expect(reused.status()).toBe(410);

    await page.goto(`/waitlist/confirm?t=${token}`);
    await page.getByRole("button", { name: "Confirm my email" }).click();
    await expect(page.getByTestId("confirm-expired")).toBeVisible();
    await expect(page.getByTestId("email-form")).toBeVisible();

    // AC9, the confirmed case: the same 202 as any other, and no send.
    const ip = drillIp();
    const asConfirmed = await join(request, ip, {
      email,
      source: "landing_drop",
      turnstileToken: TURNSTILE_TEST_KEYS.dummyToken,
    });
    expect(asConfirmed.status()).toBe(202);
    expect(await asConfirmed.json()).toEqual(CHECK_INBOX);
    expect((await row(email))?.confirmSentAt).toEqual(confirmed?.confirmSentAt);
  });

  test("AC11: RFC 8058 one-click and the page both unsubscribe; the row stays; rejoining is double opt-in again", async ({
    page,
    request,
  }) => {
    const email = emails[0]!;
    const t = unsubscribeToken(email);

    const oneClick = await request.post(`/api/waitlist/unsubscribe?t=${encodeURIComponent(t)}`, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: "List-Unsubscribe=One-Click",
    });
    expect(oneClick.status()).toBe(200);
    const off = await row(email);
    expect(off?.unsubscribedAt).not.toBeNull();
    expect(off?.confirmedAt, "the row stays, so the address stays suppressed").not.toBeNull();

    // A forged token gets the same answer and changes nothing.
    const forged = await request.post("/api/waitlist/unsubscribe", {
      data: { token: unsubscribeToken(emails[1]!).replace(/.$/, "A") },
    });
    expect(forged.status()).toBe(200);
    expect(await forged.json()).toEqual(await oneClick.json());

    // The second address: the visible link's page unsubscribes on GET.
    const second = emails[1]!;
    await db.insert(waitlist).values({ email: second, source: "landing_nav", confirmedAt: new Date() });
    await page.goto(`/waitlist/unsubscribe?t=${encodeURIComponent(unsubscribeToken(second))}`);
    await expect(page.getByRole("heading", { name: "You’re off the list." })).toBeVisible();
    expect((await row(second))?.unsubscribedAt).not.toBeNull();

    // Rejoin from that page's form: Turnstile (test key) passes, one mail goes.
    await asClient(page, drillIp());
    await page.getByRole("textbox", { name: "Email address" }).fill(second);
    await expect(page.locator('input[name="cf-turnstile-response"]')).toHaveValue(/.+/, { timeout: 15_000 });
    await page.getByRole("button", { name: "Join the waitlist" }).click();
    await expect(page.getByTestId("email-form-success")).toHaveText(CHECK_INBOX_TEXT);
    const rejoined = await row(second);
    expect(rejoined?.unsubscribedAt).toBeNull();
    expect(rejoined?.confirmedAt, "a fresh double opt-in").toBeNull();
    expect(rejoined?.confirmTokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("AC15: the prune cron is 401 without the secret, 200 { deleted } with it, and idempotent", async ({
    request,
  }) => {
    expect((await request.post("/api/cron/waitlist-prune")).status()).toBe(401);

    const authorization = `Bearer ${process.env.CRON_SECRET}`;
    const first = await request.post("/api/cron/waitlist-prune", { headers: { authorization } });
    expect(first.status()).toBe(200);
    const firstBody = (await first.json()) as { deleted: { waitlist: number; buckets: number } };
    console.log(`[waitlist-e2e] prune: ${JSON.stringify(firstBody)}`);

    const second = await request.post("/api/cron/waitlist-prune", { headers: { authorization } });
    expect(await second.json()).toEqual({ deleted: { waitlist: 0, buckets: 0 } });
    // Nothing this run needs was pruned: both rows are recent or confirmed.
    expect(await row(emails[1]!)).toBeDefined();
  });
});
