import { referralStatsSchema } from "@kept/shared";
import { expect, test, type Page } from "@playwright/test";
import { eq, inArray, like } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { clearPendingPurges } from "../lib/testing/pending-purges";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { cleanup, newScope, seedOwned, signInAs, SKIP_OWNER_UI } from "./owner-fixtures";
import { waitForTokensApplied } from "./tokens-applied";

/**
 * Profile, badge style and referrals over the wire — E10 task 009 (AC17–19,
 * D11, D12, Q19, Q20).
 *
 * NO MOCKS. Real magic-link accounts, the real Settings screen, the real
 * landing and sign-in form. The newcomer signs up the way a person does: the
 * landing with `?ref=`, its sign-in link, the `(app)` gate, the sign-in form
 * (`KEPT_EMAIL_DELIVERY=off`, so the token is read from the `verification`
 * row the form's request wrote) and the link the email would have carried.
 *
 * The badge-style fan-out is asserted by the `pending_purges` rows it queues,
 * never at the edge, and the rows are cleared at once — the seeded kept pages
 * have no manifest, and a repurge replay would write one.
 *
 * KV BUDGET (≤ 4): ZERO. Seeded pages never reach the edge, a profile or a
 * sign-up writes rows only.
 */
const scope = newScope();

async function profileRow(userId: string) {
  const [row] = await db
    .select({ referralCode: schema.profiles.referralCode, bio: schema.profiles.bio, socials: schema.profiles.socials })
    .from(schema.profiles)
    .where(eq(schema.profiles.id, userId));
  return row!;
}

async function openSection(page: Page, label: string) {
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: label }).click();
}

test.describe("profile, badge style and referrals", () => {
  test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
  test.describe.configure({ timeout: LIVE_STACK_TIMEOUT });

  test.beforeAll(async () => {
    if (SKIP_OWNER_UI) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_OWNER_UI) return;
    await cleanup(scope);
    await closeDb();
  });

  test("AC19: the profile form shows the server's refusals (bio 161, http://, unknown host) and saves a valid profile", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    await page.goto("/settings");
    await waitForTokensApplied(page);
    await openSection(page, "Profile");

    const form = page.getByTestId("profile-fields");
    const error = page.getByTestId("profile-error");
    const save = page.getByTestId("profile-save");

    await page.getByTestId("profile-bio").fill("x".repeat(161));
    await save.click();
    await expect(error).toHaveText("Bios can be up to 160 characters.");

    await page.getByTestId("profile-bio").fill("I make small pages.");
    await page.getByTestId("profile-social-github").fill("http://github.com/lena");
    await save.click();
    await expect(error).toHaveText("Use an https:// link on github.com.");

    await page.getByTestId("profile-social-github").fill("https://github.com/lena");
    await page.getByTestId("profile-social-x").fill("https://evil.example/lena");
    await save.click();
    await expect(error).toHaveText("Use an https:// link on x.com or twitter.com.");
    expect((await profileRow(userId)).bio, "a refused save writes nothing").toBeNull();

    await page.getByTestId("profile-social-x").fill("");
    await page.getByTestId("profile-display-name").fill("Lena Park");
    await save.click();
    await expect(page.getByText("Profile saved.")).toBeVisible();
    await expect(error).toBeEmpty();
    const row = await profileRow(userId);
    expect(row.bio).toBe("I make small pages.");
    expect(row.socials).toEqual({ github: "https://github.com/lena" });
    const [u] = await db.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, userId));
    expect(u!.name).toBe("Lena Park");
    await expect(form.getByText("LP", { exact: true }), "initials stand in for a picture").toBeVisible();
  });

  test("Q19: minimal is a locked row on Free; on Pro, picking it queues every kept page's re-sync", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    const kept = await seedOwned(scope, userId, "E10 badge page");

    await page.goto("/settings");
    await waitForTokensApplied(page);
    await openSection(page, "Badge");
    await expect(page.getByTestId("badge-style-standard")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("badge-style-minimal")).toHaveCount(0);
    await expect(page.getByTestId("badge-minimal-locked")).toContainText("with Pro");

    // A free account sending `minimal` anyway is refused, nothing queued.
    const refused = await page.request.patch(`${baseURL}/api/profile`, {
      headers: { origin: new URL(baseURL!).origin },
      data: { badgeStyle: "minimal" },
    });
    expect(refused.status()).toBe(400);
    expect(await refused.json()).toEqual({
      error: { code: "invalid_request", message: "The minimal badge is a Pro feature." },
    });

    await db.update(schema.profiles).set({ plan: "premium" }).where(eq(schema.profiles.id, userId));
    await page.reload();
    await waitForTokensApplied(page);
    await openSection(page, "Badge");
    await expect(page.getByTestId("badge-minimal-locked")).toHaveCount(0);
    try {
      await page.getByTestId("badge-style-minimal").click();
      await expect(page.getByText("Saved. Showing on your pages in about 2 minutes.")).toBeVisible();
      await expect(page.getByTestId("badge-style-minimal")).toHaveAttribute("aria-checked", "true");

      const queued = await db
        .select({ siteId: schema.pendingPurges.siteId, urls: schema.pendingPurges.urls })
        .from(schema.pendingPurges)
        .where(eq(schema.pendingPurges.siteId, kept.siteId));
      expect(queued, "one re-sync for the kept page, replayed by repurge").toEqual([{ siteId: kept.siteId, urls: [] }]);
    } finally {
      // The seeded page has no manifest: a replay would write one.
      await clearPendingPurges([], [kept.siteId]);
    }
  });

  test("AC17/AC18: ?ref={code} on the landing survives to a magic-link sign-up on app., one verified referral; /referrals shows it", async ({
    page,
    browser,
    baseURL,
  }) => {
    const { userId: referrerId } = await signInAs(page, baseURL!, scope);
    const { referralCode } = await profileRow(referrerId);

    // ── The newcomer, in a browser of their own.
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const email = `e10-009-${crypto.randomUUID().slice(0, 8)}@kept-e10-009.invalid`;
    try {
      const newcomer = await context.newPage();
      await newcomer.goto(`/?ref=${referralCode}`);
      const signIn = newcomer.locator("#nav-signin");
      await expect(signIn).toHaveAttribute("href", new RegExp(`/dashboard\\?ref=${referralCode}$`));
      await signIn.click();

      // The `(app)` gate keeps `ref` inside `next`.
      await newcomer.waitForURL((url) => url.pathname === "/auth");
      const next = new URL(newcomer.url()).searchParams.get("next");
      expect(next).toBe(`/dashboard?ref=${referralCode}`);

      await newcomer.getByLabel("Email").fill(email);
      await newcomer.getByRole("button", { name: "Email me a magic link" }).click();
      await expect(newcomer.getByText(email)).toBeVisible();

      // The inbox: the token the form's request stored (delivery is off).
      const [token] = await db
        .select({ identifier: schema.verification.identifier })
        .from(schema.verification)
        .where(like(schema.verification.value, `%${email}%`));
      expect(token, "the sign-in form stored a magic link").toBeTruthy();
      const link = new URL("/api/auth/magic-link/verify", baseURL);
      link.searchParams.set("token", token!.identifier);
      link.searchParams.set("callbackURL", next!);
      await newcomer.goto(link.toString());
      await newcomer.waitForURL((url) => url.pathname === "/dashboard");

      const [created] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email));
      expect(created).toBeTruthy();
      scope.userIds.push(created!.id);

      const rows = await db.select().from(schema.referrals).where(eq(schema.referrals.referredId, created!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.referrerId).toBe(referrerId);
      expect(rows[0]!.verifiedAt, "a magic link verifies the address: it counts at once").not.toBeNull();
    } finally {
      await context.close();
    }

    // ── A second referral for the same account is refused (the first wins).
    const { recordSignUpReferral } = await import("../lib/referrals/capture");
    const [created] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email));
    const otherContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const other = await signInAs(await otherContext.newPage(), baseURL!, scope).finally(() => otherContext.close());
    const { referralCode: otherCode } = await profileRow(other.userId);
    expect(await recordSignUpReferral({ id: created!.id, emailVerified: true }, otherCode)).toBe("duplicate");
    expect(await recordSignUpReferral({ id: referrerId, emailVerified: true }, referralCode)).toBe("self");
    const all = await db
      .select({ referrerId: schema.referrals.referrerId })
      .from(schema.referrals)
      .where(inArray(schema.referrals.referredId, [created!.id, referrerId]));
    expect(all).toEqual([{ referrerId }]);

    // ── GET /api/referrals and the screen.
    const stats = referralStatsSchema.parse(await (await page.request.get(`${baseURL}/api/referrals`)).json());
    expect(stats.refCode).toBe(referralCode);
    expect(stats.verifiedCount).toBe(1);
    expect(JSON.stringify(stats)).not.toContain("@");

    await page.goto("/referrals");
    await waitForTokensApplied(page);
    await expect(page.getByRole("heading", { level: 1, name: "Referrals" })).toBeVisible();
    await expect(page.getByTestId("referral-code")).toHaveText(referralCode);
    await expect(page.getByTestId("referral-link")).toHaveText(new RegExp(`/\\?ref=${referralCode}$`));
    await expect(page.getByTestId("referral-count")).toHaveText("1");
    await expect(page.getByTestId("referrals-list").getByRole("listitem")).toHaveCount(1);
    await expect(page.getByTestId("referrals-earnings")).toHaveText("Earnings start when Pro billing launches.");
    await expect(page.getByTestId("studio-nav-sidebar").getByRole("link", { name: "Referrals" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("AC18: /referrals with no verified sign-ups is the empty state", async ({ page, baseURL }) => {
    await signInAs(page, baseURL!, scope);
    await page.goto("/referrals");
    await waitForTokensApplied(page);
    await expect(page.getByTestId("referral-count")).toHaveText("0");
    await expect(page.getByTestId("referrals-empty")).toBeVisible();
    await expect(page.getByTestId("referrals-earnings")).toBeVisible();
  });
});
