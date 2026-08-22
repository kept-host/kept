import { KEPT_PAGE_LIMIT, demoteResultSchema } from "@kept/shared";
import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { AT_CAP_NOTE } from "../components/kept/kept-quota";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import {
  cleanup,
  newScope,
  publishOwned,
  readSite,
  signInAs,
  titledHtml,
  SKIP_OWNER_UI,
  type OwnedPage,
} from "./owner-fixtures";
import { waitForTokensApplied } from "./tokens-applied";

/**
 * `/dashboard` in a real browser, against the REAL dev stack — E06 task 013,
 * verification criteria **1, 2, 3 and 11**.
 *
 * NO MOCKS AND NO FIXTURE ROWS. Every page here is published through
 * `POST /api/sites` by a real magic-link session, so Postgres, R2, KV and the
 * edge cache all genuinely hold it before a single assertion runs.
 *
 * ── WHAT THIS SPEC OWNS THAT THE API SPECS CANNOT ────────────────────────────
 *
 * `owner-publish-api.spec.ts` already proves what `POST /api/sites` *returns* at
 * and under the cap. It cannot prove that the screen splits its two sections on
 * `expires_at != null`, that the four places printing the allowance agree with
 * the function that enforces it, or that a card flips itself when its clock runs
 * out while nobody is looking. Those are the four claims below, and every one of
 * them is a browser fact.
 *
 * ── ⚠️ CRITERION 11 IS A REAL WAIT, AND THAT IS THE ARCHITECTURE ─────────────
 *
 * A draft that crosses `expires_at` is **still `status = 'live'`** in Postgres
 * until E07's sweep runs — that sweep does not exist yet. The card must
 * therefore flip from the CLOCK, client-side, on `ClockProvider`'s 30 s tick,
 * and the row must be re-read afterwards to prove it is still `live` and that
 * the screen was not just echoing a status somebody wrote. Asserting a shorter
 * window than `TICK_MS` provides would be asserting a product that does not
 * exist, so the wait is budgeted honestly rather than tightened.
 *
 * SKIPS without dev credentials: CI runs fork PRs with no secrets.
 */
const scope = newScope();

/** `ClockProvider`'s tick, plus room for a render. Not tightened — see above. */
const CLOCK_TICK_BUDGET_MS = 45_000;

test.describe("the dashboard", () => {
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

  /** The one string the allowance is ever allowed to read. No typed `3`. */
  const quotaText = (used: number) => `Kept · ${used} of ${KEPT_PAGE_LIMIT}`;

  /** Demote through the real route, so the fixture and the product agree. */
  async function demote(page: Page, baseURL: string, siteId: string) {
    const response = await page.request.post(`${baseURL}/api/sites/${siteId}/demote`, {
      headers: { origin: new URL(baseURL).origin },
    });
    expect(response.status(), await response.text()).toBe(200);
    return demoteResultSchema.parse(await response.json());
  }

  /** Fill the account to `KEPT_PAGE_LIMIT` kept pages. */
  async function fillCap(page: Page, baseURL: string): Promise<OwnedPage[]> {
    const pages: OwnedPage[] = [];
    for (let i = 0; i < KEPT_PAGE_LIMIT; i += 1) {
      const owned = await publishOwned(page, baseURL, scope, `E06 cap ${i}`);
      expect(owned.outcome, "under the cap a publish must land kept").toBe("kept");
      pages.push(owned);
    }
    return pages;
  }

  test("the wall splits on the clock, names each page by its title, and hides nobody else's", async ({
    page,
    browser,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);

    const kept = await publishOwned(page, baseURL!, scope, "E06 wall kept");
    const willBeDraft = await publishOwned(page, baseURL!, scope, "E06 wall draft");
    await demote(page, baseURL!, willBeDraft.siteId);

    // A STRANGER'S PAGE, published by a genuinely separate account in a
    // genuinely separate browser context — not a row forged with a different
    // `owner_id`, because the thing under test is a query boundary and a forged
    // row could pass it for the wrong reason.
    const strangerContext = await browser.newContext({ ignoreHTTPSErrors: true });
    let stranger: OwnedPage;
    try {
      const strangerPage = await strangerContext.newPage();
      await signInAs(strangerPage, baseURL!, scope);
      stranger = await publishOwned(strangerPage, baseURL!, scope, "E06 stranger");
    } finally {
      await strangerContext.close();
    }

    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Your pages" })).toBeVisible();

    // The two groups exist as headings whatever they contain — the split IS the
    // product's model of a page, and both sections render even when one is empty.
    const keptSection = page.locator("section").filter({
      has: page.getByRole("heading", { level: 2, name: "Kept", exact: true }),
    });
    const draftSection = page.locator("section").filter({
      has: page.getByRole("heading", { level: 2, name: "Drafts", exact: true }),
    });

    // Split by `expires_at != null` and by nothing else: the demoted page moved
    // group without its `status` changing at all.
    await expect(keptSection.getByRole("link", { name: kept.name })).toBeVisible();
    await expect(draftSection.getByRole("link", { name: willBeDraft.name })).toBeVisible();
    await expect(draftSection.getByRole("link", { name: kept.name })).toHaveCount(0);
    await expect(keptSection.getByRole("link", { name: willBeDraft.name })).toHaveCount(0);
    expect((await readSite(willBeDraft.siteId)).status).toBe("live");

    // `title ?? slug`: both pages carried a `<title>`, so neither card is named
    // by its eight random characters — the whole reason `0004` exists.
    expect(kept.title).not.toBeNull();
    await expect(keptSection.getByRole("link", { name: kept.name })).toHaveText(kept.title!);

    // The slug and the serving host are both on the card, and the countdown is
    // on the draft rather than on the kept page. Scoped to the card rather than
    // to the section: the slug legitimately appears several times inside one card
    // (the address line, and the accessible names of Copy and Open), and a bare
    // text match would be a strict-mode violation rather than an assertion.
    const keptCard = keptSection.locator("article").filter({ hasText: kept.name });
    await expect(keptCard).toContainText(kept.slug);
    await expect(draftSection.getByText(/^Draft · /)).toBeVisible();

    // CRITERION 1's second half: another account's page is invisible under EVERY
    // URL — absent from the wall, and a plain 404 at its own detail route. "Not
    // yours" and "doesn't exist" are byte-identical by design.
    await expect(page.getByText(stranger.slug)).toHaveCount(0);
    const direct = await page.goto(`/site/${stranger.slug}`);
    expect(direct?.status(), "a stranger's slug must not resolve").toBe(404);
  });

  test("a brand-new account gets the invitation, not an empty grid", async ({
    page,
    baseURL,
  }) => {
    // Publishes nothing on purpose — this is the only state in which `FirstRun`
    // renders, and it is the first thing every account ever sees.
    await signInAs(page, baseURL!, scope);
    await page.goto("/dashboard");

    await expect(page.getByRole("heading", { name: "Nothing kept yet" })).toBeVisible();
    await expect(page.locator("article")).toHaveCount(0);

    // The allowance is honest about an empty account, and the at-cap sentence is
    // nowhere near it.
    await expect(page.locator("header").getByText(quotaText(0))).toBeVisible();
    await expect(page.getByText(AT_CAP_NOTE)).toHaveCount(0);

    // ⚠️ NO SECOND CALL TO ACTION (task 009). The drop-zone above IS the way to
    // publish, so a button here would be a control competing with the control it
    // points at — and one of the two would have to be the wrong place to start.
    await expect(page.getByTestId("publish-dropzone")).toBeVisible();
    await expect(
      page.getByRole("link", { name: /drop|publish|get started/i }),
    ).toHaveCount(0);
  });

  test("the allowance reads the same in every place that prints it, and moves together", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const pages = await fillCap(page, baseURL!);

    await page.goto("/dashboard");

    // 1 & 2 — the header and the drop-zone, at the cap. Both are `KeptQuotaChip`
    // reading one `KeptQuota`, so a disagreement here means two counts exist.
    const header = page.locator("header");
    const dropzone = page.getByTestId("publish-dropzone");
    await expect(header.getByText(quotaText(KEPT_PAGE_LIMIT))).toBeVisible();
    await expect(dropzone.getByText(quotaText(KEPT_PAGE_LIMIT))).toBeVisible();

    // 3 — the way out, printed once and only when the account is full. The cap
    // degrades rather than erroring, so this must be present and must not read
    // like a failure.
    await expect(header.getByText(AT_CAP_NOTE)).toBeVisible();

    // 4 — the chooser. Reached from a draft's Keep button, which at the cap
    // sends no request at all: it opens the dialog, which prints the SAME chip.
    const draft = await publishOwned(page, baseURL!, scope, "E06 quota draft");
    expect(draft.outcome, "publishing at the cap must land a draft, never a 4xx").toBe(
      "owned_draft",
    );

    await page.reload();
    await page.getByTestId("keep-button").first().click();
    const dialog = page.getByTestId("swap-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(quotaText(KEPT_PAGE_LIMIT))).toBeVisible();
    await page.getByTestId("swap-cancel").click();
    await expect(dialog).toBeHidden();

    // CHANGE A PAGE'S STATE AND ALL OF THEM MOVE. Demote one kept page through
    // the real route and every surface must read one lower — including the
    // at-cap sentence, which must now be gone entirely.
    await demote(page, baseURL!, pages[0]!.siteId);
    await page.goto("/dashboard");

    await expect(header.getByText(quotaText(KEPT_PAGE_LIMIT - 1))).toBeVisible();
    await expect(dropzone.getByText(quotaText(KEPT_PAGE_LIMIT - 1))).toBeVisible();
    await expect(page.getByText(AT_CAP_NOTE)).toHaveCount(0);
    await expect(page.getByText(quotaText(KEPT_PAGE_LIMIT))).toHaveCount(0);
  });

  test("dropping a file at the cap publishes an owned draft with a supportive notice", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    await fillCap(page, baseURL!);

    await page.goto("/dashboard");

    // THE REAL CONTROL, not a synthesised drag: `publish-dropzone` carries a real
    // `<input type="file">` behind a real button, and drag is the enhancement on
    // top of it (task 009). Driving the button is driving the keyboard path too.
    //
    // ⚠️ THE BUTTON, NOT `setInputFiles` ON THE INPUT. Calling `setInputFiles`
    // directly dispatches `change` at whatever moment the test reaches it, and on
    // a fast machine that is BEFORE React has hydrated this island — so the
    // `onChange` handler does not exist yet, the event is dropped, and the screen
    // sits idle with no notice and no error. That failure is silent and looks
    // exactly like a broken publish. Going through `filechooser` cannot race it:
    // the dialog only opens because the hydrated `onClick` called `input.click()`,
    // so observing the chooser IS the proof that the handler is attached.
    await page.waitForLoadState("networkidle");
    const title = `E06 at-cap drop ${crypto.randomUUID().slice(0, 8)}`;
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByTestId("publish-choose-file").click(),
    ]);
    await chooser.setFiles({
      name: "at-cap.html",
      mimeType: "text/html",
      buffer: Buffer.from(titledHtml(title)),
    });

    // The at-cap branch, painted in the accent rather than in `--danger`, with
    // the page's own name in it. NEVER the error region.
    const notice = page.getByTestId("publish-at-cap-notice");
    await expect(notice).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    await expect(notice).toContainText(title);
    await expect(page.getByTestId("publish-error")).toHaveCount(0);

    // And the row it actually created: owned, clocked, and carrying NO bearer
    // token. A signed-in user must never be handed a second authority on their
    // own page — the whole of epic D1.
    const [row] = await db
      .select()
      .from(schema.sites)
      .where(eq(schema.sites.title, title));
    expect(row, "the drop must have created a row").toBeDefined();
    scope.siteIds.push(row!.id);
    scope.slugs.add(row!.slug);

    expect(row!.ownerId, "the page belongs to the account").not.toBeNull();
    expect(row!.anonTokenHash, "no anon token may be minted for a signed-in publish").toBeNull();
    expect(row!.expiresAt, "at the cap the page lands as a draft").not.toBeNull();
    expect(row!.status).toBe("live");

    // The countdown is visible on the wall the moment the screen reloads.
    await page.reload();
    const card = page.locator("article").filter({ hasText: title });
    await expect(card.getByText(/^Draft · /)).toBeVisible();
  });

  test("a draft that runs out while the screen is open flips its own card, and the row does not", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(LIVE_STACK_TIMEOUT + CLOCK_TICK_BUDGET_MS);
    await signInAs(page, baseURL!, scope);
    await fillCap(page, baseURL!);

    const draft = await publishOwned(page, baseURL!, scope, "E06 expiring");
    expect(draft.outcome).toBe("owned_draft");

    // Seconds away, not already past: the point is that the card is CORRECT when
    // the screen loads and then changes its mind on the clock's own tick. A draft
    // that was already expired at first paint would prove only the initial render.
    await db
      .update(schema.sites)
      .set({ expiresAt: new Date(Date.now() + 12_000) })
      .where(eq(schema.sites.id, draft.siteId));

    await page.goto("/dashboard");

    const card = page.locator("article").filter({ hasText: draft.name });
    await expect(card.getByText("Draft · under an hour left")).toBeVisible();

    // The flip, driven by `ClockProvider`'s tick and nothing else. No reload, no
    // refetch, no navigation between these two assertions.
    await expect(card.getByText("Draft · expired")).toBeVisible({
      timeout: CLOCK_TICK_BUDGET_MS,
    });

    // AND IT DOES NOT CLAIM TO BE LIVE. The row is still `live` — E07's sweep is
    // what flips it and E07 does not exist — so a card reading `status` verbatim
    // would have said "Live" all the way through this test.
    expect(
      (await readSite(draft.siteId)).status,
      "the row is stale by design until E07 sweeps it",
    ).toBe("live");
    await expect(card.getByText("Live", { exact: true })).toHaveCount(0);
  });

  test("the screen paints from tokens, so it is correct in dark too (D4)", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    await publishOwned(page, baseURL!, scope, "E06 dark");

    await page.goto("/dashboard");
    await waitForTokensApplied(page);

    const surface = page.locator("article").first();
    const readColours = () =>
      surface.evaluate((node) => {
        const style = getComputedStyle(node);
        return { bg: style.backgroundColor, fg: style.color };
      });

    const light = await readColours();

    // Imperatively, exactly as `auth-screen`, `anon-keep-flow` and `smoke` do it:
    // v1 pins `forcedTheme="light"` and there is no toggle, so the ONLY way to
    // assert the `[data-theme="dark"]` block still resolves on a new screen is to
    // stamp the attribute. This is what keeps dark correct for the day it is
    // switched on; it is not a claim that dark is shipped.
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    const dark = await readColours();

    expect(dark.bg, "a card painted from tokens repaints in dark").not.toBe(light.bg);
    expect(dark.fg, "and so does its text").not.toBe(light.fg);
  });
});
