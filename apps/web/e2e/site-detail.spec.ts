import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { demoteConsequence } from "../lib/sites/display";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import {
  cleanup,
  newScope,
  publishOwned,
  readSite,
  signInAs,
  titledHtml,
  SKIP_OWNER_UI,
} from "./owner-fixtures";
import { waitForTokensApplied } from "./tokens-applied";

/**
 * `/site/[slug]` in a real browser, against the REAL dev stack — E06 task 013,
 * verification criteria **5, 6, 7, 10 and 12**.
 *
 * NO MOCKS. Every page is published through `POST /api/sites` by a real
 * magic-link session, and every verb below goes out over the wire to the same
 * origin-gated route a browser would call.
 *
 * ── WHAT THIS SPEC OWNS THAT THE API SPECS CANNOT ────────────────────────────
 *
 * `owner-rename-api`, `owner-replace-api` and `owner-delete-api` already prove
 * the *endpoints*: that a rename moves KV and never moves R2, that a replace
 * leaves the clock alone, that a delete archives and frees a slot. All three
 * pass. What none of them can prove is the half this screen owns:
 *
 *   · the inline rename resolves through FOUR states and leaves nothing changed
 *     on any refusal — including a collision, which the live check reports and
 *     the save still refuses;
 *   · `router.replace` lands on the new slug, without which the user's very next
 *     navigation 404s on their own page;
 *   · the demote warning is on screen BEFORE the write, not after it — a warning
 *     printed after the fact is a receipt;
 *   · a quarantined page is visible, labelled and read-only rather than gone.
 *
 * ── ⚠️ THE RENAME REFUSALS ARE ASSERTED AGAINST THE ROW, NOT THE SCREEN ──────
 *
 * Every refusal below re-reads `sites` afterwards. A rename that refused in the
 * UI but wrote anyway would look identical on screen, and the failure mode is a
 * page that has quietly moved out from under every link already shared.
 *
 * SKIPS without dev credentials: CI runs fork PRs with no secrets.
 */
const scope = newScope();

test.describe("the site detail screen", () => {
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

  test("the page is named, previewed and addressed, and its slug survives a refused rename", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 detail");
    // A second page of the SAME account, so the collision below is a real unique
    // violation on `sites_slug_key` rather than a string the client made up.
    const neighbour = await publishOwned(page, baseURL!, scope, "E06 neighbour");

    await page.goto(`/site/${site.slug}`);
    await expect(page.getByRole("heading", { level: 1, name: site.name })).toBeVisible();

    // The preview is the sandboxed `srcdoc` frame, not a screenshot service.
    await expect(page.locator("iframe")).toBeVisible();

    const status = page.getByTestId("rename-status");

    /** Type a candidate and wait for the advisory verdict (`GET /api/names/check`) to settle. */
    async function propose(candidate: string) {
      await page.getByTestId("rename-start").click();
      await page.getByTestId("rename-input").fill(candidate);
      await expect(status).toHaveAttribute("data-phase", "resolved", {
        timeout: LIVE_STACK_TIMEOUT,
      });
    }

    // ── The name rule's refusals, answered by the live check with the same
    //    status the PATCH would give — asserted as the reason code, not prose.
    const clientRefusals: [string, string][] = [
      ["Not A Slug!", "invalid"],
      ["settings", "reserved"],
      ["-leading-hyphen", "invalid"],
    ];
    for (const [candidate, reason] of clientRefusals) {
      await propose(candidate);
      await expect(status).toHaveAttribute("data-reason", reason);
      expect(
        (await readSite(site.siteId)).slug,
        `${candidate} must change nothing`,
      ).toBe(site.slug);
      await page.getByRole("button", { name: "Cancel" }).click();
    }

    // ── The fourth: a collision. The live check already knows the name is
    //    taken — and the PATCH goes out anyway, because the check is advisory
    //    and gating on it would hide the write's own answer — and the handler's
    //    own 409 sentence comes back.
    await propose(neighbour.slug);
    await expect(status).toHaveAttribute("data-reason", "taken");
    await page.getByTestId("rename-save").click();
    // The live-stack budget, not the default 5 s: this is a real PATCH against
    // the dev Neon branch and the field sits in `saving` until it answers. See
    // `live-stack.ts` — a timeout here masquerades as a rename that was allowed.
    await expect(status).toHaveAttribute("data-reason", "taken", {
      timeout: LIVE_STACK_TIMEOUT,
    });
    await expect(status).toContainText("That name is taken.");

    // Neither page moved. A collision that half-applied would be the worst
    // outcome here: two pages, one address.
    expect((await readSite(site.siteId)).slug).toBe(site.slug);
    expect((await readSite(neighbour.siteId)).slug).toBe(neighbour.slug);
    // And no premature success copy was shown for any of the four.
    await expect(page.getByTestId("rename-notice")).toHaveCount(0);
  });

  test("an accepted rename moves the page, the URL follows it, and the copy tells the truth", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 renamed");

    await page.goto(`/site/${site.slug}`);
    const chosen = `e06-013-renamed-${crypto.randomUUID().slice(0, 8)}`;
    scope.slugs.add(chosen);

    await page.getByTestId("rename-start").click();
    await page.getByTestId("rename-input").fill(chosen);
    await expect(page.getByTestId("rename-status")).toHaveAttribute(
      "data-phase",
      "resolved",
    );
    await page.getByTestId("rename-save").click();

    // `router.replace` onto the new slug. Without this the next navigation 404s
    // on the user's own page — the route is keyed by slug. The path is asserted
    // rather than the whole URL: the rename deliberately carries `?renamedFrom=`
    // so its success copy survives the remount this very navigation causes.
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: LIVE_STACK_TIMEOUT })
      .toBe(`/site/${chosen}`);
    expect(new URL(page.url()).searchParams.get("renamedFrom")).toBe(site.slug);
    expect((await readSite(site.siteId)).slug).toBe(chosen);

    // The success copy is present — REGRESSION GUARD: before task 013 it was set
    // in state a millisecond before the navigation that discarded it, so this
    // sentence existed, was correct, and was never once seen.
    //
    // It is honest about the old address, which keeps answering for a little
    // while. It must NOT claim an instant cutover — that is epic D2 and it is a
    // fact of the architecture, not a bug to tighten away.
    const notice = page.getByTestId("rename-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(chosen);
    await expect(notice).not.toContainText(/instantly|immediately stops/i);
  });

  test("dropping a new file replaces the bytes at the same address and leaves the clock alone", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 replace me");

    const before = await readSite(site.siteId);
    await page.goto(`/site/${site.slug}`);

    // Through the button, never `setInputFiles` on the input — see the long note
    // in `dashboard.spec.ts`: a `change` dispatched before this island hydrates
    // is dropped silently, and the screen then looks like a broken replace.
    await page.waitForLoadState("networkidle");
    const replacementTitle = `E06 replaced ${crypto.randomUUID().slice(0, 8)}`;
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page
        .getByRole("button", { name: new RegExp(`Choose file for ${site.name}`) })
        .click(),
    ]);
    await chooser.setFiles({
      name: "replacement.html",
      mimeType: "text/html",
      buffer: Buffer.from(titledHtml(replacementTitle)),
    });

    // The screen re-reads the route after a replace, so the new `<title>` is what
    // the heading says — asserted on the OWNED replace path, one of D5's four.
    await expect(
      page.getByRole("heading", { level: 1, name: replacementTitle }),
    ).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });

    const after = await readSite(site.siteId);
    expect(after.slug, "the address does not move on a replace").toBe(before.slug);
    expect(after.title, "the title is re-extracted from the new bytes").toBe(
      replacementTitle,
    );
    expect(after.currentVersionId, "a replace mints a new version").not.toBe(
      before.currentVersionId,
    );
    expect(
      after.expiresAt,
      "a replace must never touch the clock — a weekly re-drop would hold a page forever",
    ).toEqual(before.expiresAt);

    // Version history is retained; the rollback UI is E11's.
    const versions = await db
      .select({ id: schema.siteVersions.id })
      .from(schema.siteVersions)
      .where(eq(schema.siteVersions.siteId, site.siteId));
    expect(versions.length).toBeGreaterThan(1);
  });

  test("demote warns before it writes, keep puts it back, and delete leaves the screen", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 verbs");
    expect(site.outcome).toBe("kept");

    await page.goto(`/site/${site.slug}`);

    // ── DEMOTE: the consequence, on screen, BEFORE anything is written.
    await page.getByTestId("demote-button").click();
    const demoteDialog = page.getByTestId("demote-dialog");
    await expect(demoteDialog).toBeVisible();
    // The sentence names the page and states the window in `DRAFT_TTL_DAYS`
    // terms. Asserted against the shared function, so a typed `7` fails here too.
    await expect(demoteDialog).toContainText(demoteConsequence(site.name));
    expect(
      (await readSite(site.siteId)).expiresAt,
      "the warning must precede the write, not follow it",
    ).toBeNull();

    await page.getByTestId("demote-dialog-confirm").click();
    await expect(demoteDialog).toBeHidden({ timeout: LIVE_STACK_TIMEOUT });
    await expect
      .poll(async () => (await readSite(site.siteId)).expiresAt !== null, {
        timeout: LIVE_STACK_TIMEOUT,
      })
      .toBe(true);

    // ── KEEP, from this same surface (criterion 10's "both surfaces").
    await expect(page.getByTestId("keep-button")).toBeVisible();
    await page.getByTestId("keep-button").click();
    await expect
      .poll(async () => (await readSite(site.siteId)).expiresAt === null, {
        timeout: LIVE_STACK_TIMEOUT,
      })
      .toBe(true);
    await expect(page.getByTestId("manage-error")).toHaveCount(0);

    // ── DELETE: archived, retained, and the screen goes back to the wall rather
    //    than sitting on a page that no longer serves.
    await page.getByTestId("delete-button").click();
    const deleteDialog = page.getByTestId("delete-dialog");
    await expect(deleteDialog).toBeVisible();
    await expect(deleteDialog).toContainText(site.name);
    expect(
      (await readSite(site.siteId)).status,
      "the delete dialog must not have written anything yet",
    ).toBe("live");

    await page.getByTestId("delete-dialog-confirm").click();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: LIVE_STACK_TIMEOUT });

    // ARCHIVED: an owner deleting a page keeps the row and the bytes. Owners
    // reach `archived`; `removed` is E07's.
    expect((await readSite(site.siteId)).status).toBe("archived");
  });

  test("a quarantined page is visible, labelled and read-only — never quietly gone", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 quarantined");

    // E07 owns this flip and does not exist yet, so the state is written directly
    // — the only thing in this suite that is, and it is a state E06 RENDERS and
    // is forbidden from writing.
    await db
      .update(schema.sites)
      .set({ status: "quarantined" })
      .where(eq(schema.sites.id, site.siteId));

    // IT DOES NOT VANISH FROM THE WALL. A page that disappears when it is flagged
    // is indistinguishable from data loss.
    await page.goto("/dashboard");
    await expect(page.getByRole("link", { name: site.name })).toBeVisible();

    await page.goto(`/site/${site.slug}`);
    await expect(page.getByRole("heading", { level: 1, name: site.name })).toBeVisible();

    // LABELLED, with the reason — refused with an explanation, never hidden.
    const refusal = page.getByTestId("site-refusal");
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText("under review");

    // Read-only: the three verbs that change the page are disabled.
    await expect(page.getByTestId("rename-start")).toBeDisabled();
    await expect(page.getByTestId("demote-button")).toBeDisabled();
    await expect(
      page.locator('section:has-text("Replace the file") input[type="file"]'),
    ).toBeDisabled();

    // And the two that must keep working, do. Delete is the owner's way out of a
    // page they no longer want, and a review must not take it away.
    await expect(page.getByTestId("delete-button")).toBeEnabled();

    expect(
      (await readSite(site.siteId)).status,
      "rendering a flagged state must not have changed it",
    ).toBe("quarantined");
  });

  test("the screen paints from tokens, so it is correct in dark too (D4)", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 detail dark");

    await page.goto(`/site/${site.slug}`);
    await waitForTokensApplied(page);

    // Stamped imperatively, exactly as `auth-screen`, `anon-keep-flow` and
    // `smoke` do it: v1 pins `forcedTheme="light"` and there is no toggle, so
    // this is the only way to reach the `[data-theme="dark"]` block. Keeping the
    // new screens under it is what keeps dark correct for the day it is switched
    // on — it is not a claim that dark ships (epic D4).
    const panel = page.locator("aside section").first();
    const light = await panel.evaluate((node) => getComputedStyle(node).backgroundColor);
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    const dark = await panel.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(dark, "the manage panel repaints from tokens in dark").not.toBe(light);
  });
});
