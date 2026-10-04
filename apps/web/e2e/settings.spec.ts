import { readFile } from "node:fs/promises";

import { limitsFor } from "@kept/shared";
import { expect, test, type Page } from "@playwright/test";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import {
  cleanup,
  newScope,
  publishOwned,
  readSite,
  seedKept,
  signInAs,
  SKIP_OWNER_UI,
} from "./owner-fixtures";
import { waitForTokensApplied } from "./tokens-applied";

/**
 * `/settings` in a real browser, against the REAL dev stack — E06 task 013
 * (PRD §5.8, §9.3; AC10 for this screen, AC42, the UI half of AC43).
 *
 * NO MOCKS. Every account is a brand-new one signed in through the real
 * magic-link verify endpoint (`signInAs`). Sign-in methods are real Better Auth
 * `account` rows and every Connect / Disconnect hits Better Auth's own
 * endpoint; the export is the real streamed zip, downloaded by the browser; the
 * deletion is fired for real on an account seeded seconds earlier.
 *
 * What the API specs own is not repeated: `account-deletion.spec.ts` owns the
 * row-state claims of `DELETE /api/account`, `owner-delete-api` the export's
 * bytes. This spec owns what the SCREEN does: which sections exist and which do
 * not, the numbers it states, the gate in front of the deletion, the start
 * signal in front of the export, and the last-provider refusal.
 *
 * SKIPS without dev credentials: CI runs fork PRs with no secrets.
 */
const scope = newScope();

const SECTIONS = ["Account", "Plan", "Your data", "Danger zone"] as const;

/** Open one section from the settings nav. */
async function openSection(page: Page, label: (typeof SECTIONS)[number]) {
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: label }).click();
}

/**
 * A provider identity, as Better Auth writes one at the end of an OAuth link —
 * a real row in the real `account` table, so Better Auth's real
 * `/unlink-account` acts on it. No credential: no token, no password.
 */
async function connectProvider(userId: string, providerId: "github" | "google") {
  await db.insert(schema.account).values({
    id: crypto.randomUUID(),
    accountId: `e06-013-${providerId}-${crypto.randomUUID().slice(0, 8)}`,
    providerId,
    userId,
    updatedAt: new Date(),
  });
}

async function providersOf(userId: string): Promise<string[]> {
  const rows = await db
    .select({ providerId: schema.account.providerId })
    .from(schema.account)
    .where(eq(schema.account.userId, userId));
  return rows.map((row) => row.providerId).sort();
}

/** The PRD §5.8 sentence for refusing to remove the last provider. */
const LAST_METHOD = "You need at least one way to sign in.";

test.describe("the settings screen", () => {
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

  test("four sections and nothing from a later epic (AC10); the account shows its email and the email link is always on", async ({
    page,
    baseURL,
  }) => {
    const { email } = await signInAs(page, baseURL!, scope);

    await page.goto("/settings");
    await waitForTokensApplied(page);
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

    // The shell's nav is Pages and Settings only; the settings nav is the PRD's four.
    await expect(page.getByTestId("studio-nav-sidebar").getByRole("link")).toHaveText(["Pages", "Settings"]);
    await expect(
      page.getByRole("navigation", { name: "Settings sections" }).getByRole("button"),
    ).toHaveText([...SECTIONS]);

    // ── Account: the session's own address, and a magic-link account has no
    // provider rows — so both providers offer Connect and the email link is
    // the door that is always there.
    await expect(page.getByTestId("account-email")).toHaveText(email);
    await expect(page.getByTestId("link-github")).toHaveText(/Connect/);
    await expect(page.getByTestId("link-google")).toHaveText(/Connect/);
    await expect(page.getByRole("button", { name: /Disconnect/ })).toHaveCount(0);
    const emailRow = page.locator('[data-provider-row="email"]');
    await expect(emailRow).toContainText("Email link");
    await expect(emailRow).toContainText(email);
    await expect(emailRow).toContainText(/Always on/i);
    await expect(emailRow.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(page.getByTestId("link-error")).toHaveCount(0);

    // ── AC10: walk every section; none of the design's later-epic elements is
    // in the DOM — not hidden, not disabled, not "Soon".
    const ABSENT = [
      "handle", // Handle section, "Rename handle", "New handle"
      "your wall", // "Your wall lives at", "Your wall · {handle}.kept.host"
      "own domain",
      "dns records",
      "remove domain",
      "a domain you own",
      "referral",
      "?ref=",
      "rewards for founding",
      "sign-ups",
      "founding",
      "apply",
      "€",
      "/mo",
      "soon",
      "remix",
      "30-day download link",
      "every version and wall setting",
      "released after 30 days",
      // D4: no theme control of any kind, working or locked.
      "theme",
    ];
    for (const section of SECTIONS) {
      await openSection(page, section);
      const text = (await page.locator("body").innerText()).toLowerCase();
      for (const phrase of ABSENT) {
        expect(text, `"${phrase}" must not be on the ${section} section`).not.toContain(phrase);
      }
      await expect(page.getByRole("textbox", { name: /^name$/i }), "no display-name field").toHaveCount(0);
      await expect(page.getByRole("link", { name: /wall|explore|referrals/i })).toHaveCount(0);
    }

    // Every surface paints from tokens, so dark is right the day it ships —
    // stamped imperatively as `auth-screen` and `smoke` do (no toggle exists).
    await openSection(page, "Account");
    const field = page.getByTestId("account-email");
    const light = await field.evaluate((node) => getComputedStyle(node).backgroundColor);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    expect(await field.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(light);
  });

  test("a link refused by the OAuth round trip says why; anything unrecognised is the generic sentence", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);

    await page.goto("/settings?error=unable_to_link_account");
    await expect(page.getByTestId("link-error")).toContainText("did not confirm an email address");

    await page.goto("/settings?error=something_new");
    await expect(page.getByTestId("link-error")).toHaveText("Couldn't save. Try again.");
  });

  test("AC42: Disconnect removes a provider; the last one cannot be removed, and a stale tab is refused with the PRD sentence", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    await connectProvider(userId, "github");
    await connectProvider(userId, "google");

    await page.goto("/settings");
    await expect(page.getByTestId("unlink-github")).toBeEnabled();
    await expect(page.getByTestId("unlink-google")).toBeEnabled();

    // ── Disconnect, for real, through Better Auth's own endpoint.
    await page.getByTestId("unlink-google").click();
    await expect(page.getByText("Google is no longer connected.")).toBeVisible();
    await expect(page.getByTestId("link-google")).toBeVisible();
    expect(await providersOf(userId)).toEqual(["github"]);

    // ── One provider left: its Disconnect is disabled and says why, in text.
    await expect(page.getByTestId("unlink-github")).toBeDisabled();
    await expect(page.getByTestId("last-method-note")).toHaveText(LAST_METHOD);

    // ── The stale tab: the screen still shows two providers when another tab
    // has already removed one. Better Auth's `/unlink-account` refuses the last
    // row (`FAILED_TO_UNLINK_LAST_ACCOUNT`) and the client maps it to the
    // studio's `last_sign_in_method` sentence.
    await connectProvider(userId, "google");
    await page.reload();
    await expect(page.getByTestId("unlink-github")).toBeEnabled();
    await db
      .delete(schema.account)
      .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "google")));

    await page.getByTestId("unlink-github").click();
    await expect(page.getByTestId("link-error")).toHaveText(LAST_METHOD);
    expect(await providersOf(userId), "the refusal removed nothing").toEqual(["github"]);
    // The screen re-read the table: GitHub is now the last door.
    await expect(page.getByTestId("unlink-github")).toBeDisabled();
  });

  test("plan: the badge, meters from the account's real counts, and the Pro list from PLAN_LIMITS with no CTA — none of it on Pro", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    const seeded = await seedKept(scope, userId, 3);
    // Two of them carry chosen names, so the names meter is a real count.
    await db
      .update(schema.sites)
      .set({ nameKind: "chosen" })
      .where(inArray(schema.sites.id, seeded.slice(0, 2).map((page) => page.siteId)));

    const free = limitsFor("free");
    const pro = limitsFor("premium");

    await page.goto("/settings");
    await openSection(page, "Plan");
    const plan = page.getByTestId("settings-section-plan");
    await expect(plan.getByTestId("plan-badge")).toHaveText("Free");
    await expect(plan.getByTestId("meter-kept")).toHaveText(new RegExp(`Kept\\s*3 / ${free.keptPages}`, "i"));
    await expect(plan.getByTestId("meter-names")).toHaveText(new RegExp(`Names\\s*2 / ${free.chosenNames}`, "i"));
    await expect(plan).toContainText(`Drafts are unlimited. Past ${free.keptPages}, new pages land as drafts.`);

    // The short Pro list, each number from PLAN_LIMITS — and no link: the CTA
    // waits for NEXT_PUBLIC_LOCKED_CTA_URL (D15), which E06 leaves unset.
    const list = plan.getByTestId("pro-list");
    const rows = [
      "Wall editor",
      "Share kit",
      `${pro.keptPages.toLocaleString("en-US")} kept pages`,
      `${pro.chosenNames} names`,
      `${pro.nameMinLength}-letter names`,
      "Minimal badge",
      `${pro.previousVersions} versions of every page`,
    ];
    await expect(list.getByRole("listitem")).toHaveCount(rows.length);
    // Each row's value line, in order (the row also says "a Pro feature,
    // locked" to screen readers, so it contains the line rather than equals it).
    await expect(list.getByRole("listitem")).toContainText(rows);
    await expect(list.getByRole("link")).toHaveCount(0);

    // ── Pro: its own limits in the meters, and nothing locked.
    await db.update(schema.profiles).set({ plan: "premium" }).where(eq(schema.profiles.id, userId));
    await page.reload();
    await openSection(page, "Plan");
    await expect(plan.getByTestId("plan-badge")).toHaveText("Pro");
    await expect(plan.getByTestId("meter-kept")).toHaveText(new RegExp(`Kept\\s*3 / ${pro.keptPages}`, "i"));
    await expect(plan.getByTestId("meter-names")).toHaveText(new RegExp(`Names\\s*2 / ${pro.chosenNames}`, "i"));
    await expect(plan.getByTestId("pro-list")).toHaveCount(0);
  });

  test("your data: nothing to export yet, then Preparing… until the browser starts saving the real zip", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);

    await page.goto("/settings");
    await openSection(page, "Your data");
    const button = page.getByTestId("export-download");
    await expect(button).toBeDisabled();
    await expect(page.getByTestId("export-panel")).toContainText("Nothing to export yet.");

    const published = await publishOwned(page, baseURL!, scope, "E06 settings export");
    await page.reload();
    await openSection(page, "Your data");
    await expect(button).toBeEnabled();
    await expect(page.getByTestId("export-panel")).not.toContainText("Nothing to export yet.");

    // "Preparing…" may last only as long as one owner-scoped read, so it is
    // recorded as it happens rather than polled for afterwards.
    await button.evaluate((node) => {
      const seen: string[] = [];
      (window as unknown as { exportLabels: string[] }).exportLabels = seen;
      new MutationObserver(() => seen.push(node.textContent ?? "")).observe(node, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });

    const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
    expect(download.suggestedFilename()).toMatch(/^kept-export-\d{4}-\d{2}-\d{2}\.zip$/);

    // The route's start signal ended "Preparing…", and nothing failed.
    await expect(button).toHaveText("Download export");
    await expect(page.getByTestId("export-error")).toHaveCount(0);
    const labels = await page.evaluate(() => (window as unknown as { exportLabels: string[] }).exportLabels);
    expect(labels.some((label) => label.includes("Preparing…")), labels.join(" | ")).toBe(true);

    // A native download of the real archive: a zip holding the manifest and the page.
    const bytes = await readFile((await download.path())!);
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(bytes.includes(Buffer.from("kept-export.json"))).toBe(true);
    expect(bytes.includes(Buffer.from(`${published.slug}/index.html`))).toBe(true);
  });

  test("your data: an export the server refuses ends Preparing… with the generic sentence, not a spinner forever", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    await publishOwned(page, baseURL!, scope, "E06 settings export refused");

    await page.goto("/settings");
    await openSection(page, "Your data");
    const button = page.getByTestId("export-download");
    await expect(button).toBeEnabled();

    // The session ends while the screen is open (another device signed out,
    // or the account was deleted there): the route answers 401, and its
    // start signal says the export did not start.
    await db.delete(schema.session).where(eq(schema.session.userId, userId));
    await button.click();

    await expect(page.getByTestId("export-error")).toHaveText("Couldn't save. Try again.");
    await expect(button).toHaveText("Download export");
  });

  test("sign out leaves the studio for the apex landing, signed out", async ({ page, baseURL }) => {
    await signInAs(page, baseURL!, scope);

    await page.goto("/settings");
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: LIVE_STACK_TIMEOUT });

    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/auth\?/, { timeout: LIVE_STACK_TIMEOUT });
  });

  test("the deletion gate states real counts and the PRD copy, arms only on the account's email, and cancelling changes nothing", async ({
    page,
    baseURL,
  }) => {
    const { userId, email } = await signInAs(page, baseURL!, scope);

    // A real mix: the free limit of kept pages (seeded rows) and a draft past
    // them (a real publish), so the numbers are facts about this account.
    const limit = limitsFor("free").keptPages;
    await seedKept(scope, userId, limit);
    const draft = await publishOwned(page, baseURL!, scope, "E06 settings draft");
    expect(draft.outcome).toBe("owned_draft");
    const witness = await readSite(draft.siteId);

    await page.goto("/settings");
    await openSection(page, "Danger zone");
    const panel = page.getByTestId("delete-account-panel");
    await expect(panel.getByTestId("delete-account-counts")).toHaveText(
      `Your ${limit} kept pages and 1 draft go offline and are archived.`,
    );
    // D16: names are held for 12 months — never the design's "30 days".
    await expect(panel).toContainText("Your page names are held for 12 months before anyone else can take them.");

    await page.getByTestId("delete-account-open").click();
    await expect(page.getByTestId("delete-account-copy")).toHaveText(
      "All your pages go offline within about 2 minutes. You can't undo this. Your page names are held for 12 months before anyone else can take them.",
    );
    const input = page.getByTestId("delete-account-input");
    const confirm = page.getByTestId("delete-account-confirm");
    await expect(input).toBeFocused();
    await expect(confirm, "inert until the email matches").toBeDisabled();

    // Anything but this account's address leaves it inert — the design's
    // `delete {handle}` phrase included.
    for (const nearMiss of ["", "delete my account", `delete ${email}`, email.slice(0, -1), `x${email}`]) {
      await input.fill(nearMiss);
      await expect(confirm, `"${nearMiss}" must not arm the button`).toBeDisabled();
    }

    // The address arms it, in any case and with stray spaces (task 008's rule).
    await input.fill(`  ${email.toUpperCase()} `);
    await expect(confirm).toBeEnabled();

    // Cancelling, with the button armed, changes nothing.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("delete-account-dialog")).toBeHidden();
    expect(
      await readSite(draft.siteId),
      "not one row may move until the destructive button is actually pressed",
    ).toEqual(witness);

    // Reopening starts from an empty field.
    await page.getByTestId("delete-account-open").click();
    await expect(input).toHaveValue("");
    await expect(confirm).toBeDisabled();
  });

  test("AC43 (UI half): confirm, and the user lands on the apex signed out with every page archived", async ({
    page,
    baseURL,
  }) => {
    const { userId, email } = await signInAs(page, baseURL!, scope);
    const kept = await publishOwned(page, baseURL!, scope, "E06 farewell kept");
    const second = await publishOwned(page, baseURL!, scope, "E06 farewell two");

    await page.goto("/settings");
    await openSection(page, "Danger zone");
    await expect(page.getByTestId("delete-account-counts")).toHaveText(
      "Your 2 kept pages and 0 drafts go offline and are archived.",
    );
    await page.getByTestId("delete-account-open").click();
    await page.getByTestId("delete-account-input").fill(email);
    await page.getByTestId("delete-account-confirm").click();

    // The browser ends on the apex, signed out.
    await page.waitForURL((url) => url.pathname === "/", { timeout: LIVE_STACK_TIMEOUT });

    for (const site of [kept, second]) {
      const row = await readSite(site.siteId);
      expect(row.status, site.slug).toBe("archived");
      expect(row.purgeAfter, `${site.slug} must be sweepable by E07`).not.toBeNull();
      expect(row.ownerId, "no owner left").toBeNull();
    }
    // Unscoped: a live page with no owner, no token and no clock is unreachable
    // by any authority in the product, so an owner-scoped query could not see it.
    expect(
      await db
        .select({ id: schema.sites.id })
        .from(schema.sites)
        .where(
          and(
            eq(schema.sites.status, "live"),
            isNull(schema.sites.ownerId),
            isNull(schema.sites.anonTokenHash),
            isNull(schema.sites.expiresAt),
          ),
        ),
    ).toEqual([]);
    expect(await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, userId))).toEqual([]);

    // The session is gone in this browser: the gate turns the tab away.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/auth\?/, { timeout: LIVE_STACK_TIMEOUT });
  });

  test("phone: the top bar carries the wordmark, the section nav is one row, and nothing scrolls sideways", async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAs(page, baseURL!, scope);

    await page.goto("/settings");
    await expect(page.getByRole("banner").getByRole("link", { name: "kept" })).toBeVisible();

    const tops = await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button")
      .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
    expect(new Set(tops).size, `section entries on one row: ${tops.join(", ")}`).toBe(1);

    for (const section of SECTIONS) {
      await openSection(page, section);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${section} must not scroll sideways at 390px`).toBeLessThanOrEqual(0);
    }
  });
});
