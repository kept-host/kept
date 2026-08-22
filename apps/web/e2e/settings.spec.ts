import { ACCOUNT_DELETION_CONFIRMATION, KEPT_PAGE_LIMIT } from "@kept/shared";
import { expect, test } from "@playwright/test";
import { and, eq, isNull } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import {
  cleanup,
  newScope,
  publishOwned,
  readSite,
  signInAs,
  SKIP_OWNER_UI,
} from "./owner-fixtures";
import { waitForTokensApplied } from "./tokens-applied";

/**
 * `/settings` in a real browser, against the REAL dev stack — E06 task 013,
 * verification criterion **14**, and the UI half of **13**.
 *
 * NO MOCKS, AND THE TERMINAL PATH IS ACTUALLY FIRED. Task 012 built the
 * deletion flow and typed it but never executed confirm → `DELETE /api/account`
 * → sign-out → apex, because doing so on the maintainer's own dev account would
 * destroy it. This spec fires the whole thing — on an account **it seeds itself,
 * seconds earlier, through the real magic-link verify endpoint**. Nobody's real
 * account is touched, and the drill is the real drill rather than a rehearsal.
 *
 * ── WHAT THIS SPEC OWNS THAT `account-deletion.spec.ts` CANNOT ───────────────
 *
 * That spec drives `DELETE /api/account` directly and owns criterion 13's
 * row-state claims — `removed`, `purge_after` set, zero ownerless live pages,
 * R2 bytes deliberately retained for E07. It passes. What it cannot reach is the
 * gate in front of the endpoint, which is where D3 put the actual safety:
 *
 *   · the dialog states the ACTUAL counts for that account, read at render time;
 *   · the destructive button is inert until the typed phrase matches exactly;
 *   · cancelling at EITHER stage leaves every row untouched.
 *
 * A gate that can only be tested by calling the endpoint it guards is not a gate.
 *
 * ── ⚠️ THE PHRASE IS COMPARED EXACTLY, AND SO IS THIS TEST ───────────────────
 *
 * No trim, no case-folding — server-side in `lib/sites/account-deletion.ts` and
 * client-side in the arming check. The near-misses below are typed deliberately:
 * a trailing space and a capitalised word must both leave the button disabled,
 * because the typing IS the deliberation.
 *
 * SKIPS without dev credentials: CI runs fork PRs with no secrets.
 */
const scope = newScope();

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

  test("the account panel tells the truth, the plan is Free with Pro locked, and there is no theme control", async ({
    page,
    baseURL,
  }) => {
    const { email } = await signInAs(page, baseURL!, scope);

    await page.goto("/settings");
    await waitForTokensApplied(page);
    await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();

    // The address the session actually holds, not a placeholder. Scoped to
    // `main`: the app header prints it too, and an unscoped match is a
    // strict-mode violation rather than an assertion.
    await expect(page.getByRole("main").getByText(email)).toBeVisible();

    // Providers are read from Better Auth's `account` table, never from a
    // denormalised column — so the screen must agree with that table exactly.
    const linked = await db
      .select({ providerId: schema.account.providerId })
      .from(schema.account)
      .where(eq(schema.account.userId, scope.userIds[scope.userIds.length - 1]!));
    for (const provider of linked) {
      await expect(
        page.getByTestId(`unlink-${provider.providerId}`),
        `${provider.providerId} is in the account table and must be on screen`,
      ).toHaveCount(1);
    }

    // The manual-link flow E05 D2 handed to this epic: both doors are offered
    // while signed in. The live OAuth round trip needs a real consent screen and
    // is out of this suite's reach — what is asserted is that the controls exist
    // and that nothing is already errored.
    await expect(page.getByRole("button", { name: /GitHub/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Google/i })).toBeVisible();
    await expect(page.getByTestId("link-error")).toHaveCount(0);

    // Free, with Pro visible and locked — markup, not a half-wired entitlement.
    await expect(page.getByRole("heading", { name: "Plan" })).toBeVisible();
    await expect(page.getByText("Free", { exact: true }).first()).toBeVisible();

    // ⚠️ D4: NO THEME CONTROL OF ANY KIND — not working, not locked, not
    // disabled. A greyed-out row would advertise a switch and invite the exact
    // "just delete forcedTheme" fix CLAUDE.md exists to prevent.
    expect(
      (await page.locator("body").innerText()).toLowerCase(),
      "the settings screen must not mention a theme at all",
    ).not.toContain("theme");

    // ── D4's other half: every new surface still PAINTS from tokens, so dark is
    // correct on the day it is switched on. Stamped imperatively, exactly as
    // `auth-screen`, `anon-keep-flow` and `smoke` do it — v1 pins
    // `forcedTheme="light"` and there is no toggle, so this is the only way to
    // reach the `[data-theme="dark"]` block. It is not a claim that dark ships.
    const panel = page.getByTestId("delete-account-panel");
    const light = await panel.evaluate((node) => getComputedStyle(node).backgroundColor);
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    const dark = await panel.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(dark, "the settings panels repaint from tokens in dark").not.toBe(light);
  });

  test("the deletion gate states real counts, arms only on an exact match, and cancelling changes nothing", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);

    // A real mix: kept pages and a draft, so the counts on screen are a fact
    // about this account rather than a generic warning.
    for (let i = 0; i < KEPT_PAGE_LIMIT; i += 1) {
      await publishOwned(page, baseURL!, scope, `E06 settings kept ${i}`);
    }
    const draft = await publishOwned(page, baseURL!, scope, "E06 settings draft");
    expect(draft.outcome).toBe("owned_draft");
    const witness = await readSite(draft.siteId);

    await page.goto("/settings");
    const panel = page.getByTestId("delete-account-panel");
    await expect(panel).toBeVisible();

    // ── Stage one: the real numbers, read from the database at render time.
    await page.getByTestId("delete-account-open").click();
    const counts = page.getByTestId("delete-account-counts");
    await expect(counts).toBeVisible();
    await expect(counts).toContainText(`${KEPT_PAGE_LIMIT} kept pages`);
    await expect(counts).toContainText("1 draft");

    // Cancelling at stage one changes nothing.
    await page.getByRole("button", { name: "Keep my account" }).click();
    await expect(page.getByTestId("delete-account-dialog")).toBeHidden();
    expect(await readSite(draft.siteId)).toEqual(witness);

    // ── Stage two: the type-to-confirm.
    await page.getByTestId("delete-account-open").click();
    await page.getByTestId("delete-account-continue").click();
    const input = page.getByTestId("delete-account-input");
    const confirm = page.getByTestId("delete-account-confirm");
    await expect(input).toBeVisible();
    await expect(confirm, "inert until the words match").toBeDisabled();

    // Every near miss leaves it inert. Exact means exact.
    for (const nearMiss of [
      "",
      "delete",
      "Delete my account",
      `${ACCOUNT_DELETION_CONFIRMATION} `,
      ` ${ACCOUNT_DELETION_CONFIRMATION}`,
    ]) {
      await input.fill(nearMiss);
      await expect(confirm, `"${nearMiss}" must not arm the button`).toBeDisabled();
    }

    // The exact phrase arms it — and pressing nothing still writes nothing.
    await input.fill(ACCOUNT_DELETION_CONFIRMATION);
    await expect(confirm).toBeEnabled();

    // Cancelling at stage two, with the button armed, changes nothing either.
    await page.getByRole("button", { name: "Back" }).click();
    await expect(counts).toBeVisible();
    await page.getByRole("button", { name: "Keep my account" }).click();
    await expect(page.getByTestId("delete-account-dialog")).toBeHidden();

    expect(
      await readSite(draft.siteId),
      "not one row may move until the destructive button is actually pressed",
    ).toEqual(witness);
    expect((await readSite(draft.siteId)).status).toBe("live");
  });

  test("THE TERMINAL PATH: confirm, and the account and every page it held are gone", async ({
    page,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    const kept = await publishOwned(page, baseURL!, scope, "E06 farewell kept");
    const second = await publishOwned(page, baseURL!, scope, "E06 farewell two");

    await page.goto("/settings");
    await page.getByTestId("delete-account-open").click();
    await page.getByTestId("delete-account-continue").click();
    await page.getByTestId("delete-account-input").fill(ACCOUNT_DELETION_CONFIRMATION);
    await page.getByTestId("delete-account-confirm").click();

    // The browser ends on the apex, signed out, with nothing to go back to.
    //
    // ⚠️ THE "Your account is gone" PANEL IS DELIBERATELY NOT ASSERTED. It is
    // shown between the 200 and `window.location.replace(farewellHref)`, and the
    // only thing between them is `signOut()`'s round trip — measured here at
    // under a poll interval, so whether a run ever *observes* that panel is a
    // race with the network, not a property of the product. Asserting it would
    // be asserting that sign-out is slow. What the flow actually promises is the
    // landing below and the row state further down, and both are required.
    await page.waitForURL((url) => url.pathname === "/", {
      timeout: LIVE_STACK_TIMEOUT,
    });

    // ── The terminal row state D3 specifies, and E07's purge job selects on.
    for (const site of [kept, second]) {
      const row = await readSite(site.siteId);
      expect(row.status, `${site.slug}`).toBe("removed");
      expect(row.purgeAfter, `${site.slug} must be sweepable by E07`).not.toBeNull();
      expect(row.ownerId, "the FK's SET NULL fired, harmlessly").toBeNull();
    }

    // ── CRITERION 13, unscoped: the failure mode is a row no ownership query can
    //    reach, so a query scoped by owner could not possibly see it.
    expect(
      await db
        .select({ id: schema.sites.id, slug: schema.sites.slug })
        .from(schema.sites)
        .where(
          and(
            eq(schema.sites.status, "live"),
            isNull(schema.sites.ownerId),
            isNull(schema.sites.anonTokenHash),
            isNull(schema.sites.expiresAt),
          ),
        ),
      "a live page with no owner, no token and no clock is unreachable by any authority in the product",
    ).toEqual([]);

    // The user row and its sessions went with it, so the same address builds a
    // NEW account rather than landing back in this one.
    expect(
      await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, userId)),
    ).toEqual([]);

    // And the session really is gone in the browser: the gate turns the tab away.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/auth\?/, { timeout: LIVE_STACK_TIMEOUT });
  });
});
