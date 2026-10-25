import { DRAFT_GRACE_DAYS } from "@kept/shared";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { and, eq, inArray } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { ADMIN_PREVIEW_CSP } from "../lib/routing/admin-csp";
import { fileSetSummary, formatBytes } from "../lib/sites/display";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { cleanup, newScope, publishOwned, readSite, seedOwnedSet, signInAs, SKIP_OWNER_UI } from "./owner-fixtures";

/**
 * The moderation screen (E07 task 011, AC20, AC21, the admin half of AC39),
 * against the REAL dev stack, open mode. `admin-moderation.closed.spec.ts`
 * re-checks the gate on a closed deploy.
 *
 *   - the gate: signed out, signed in as anyone else, and every admin API → the
 *     bare 404; the CSP on `/admin/*` and on nothing else;
 *   - the screen hydrates under that CSP (a tab switch is client navigation);
 *   - the item view: facts, scan, a `sandbox="allow-scripts"` preview frame on
 *     its own route whose CSP lets the page's scripts run in an opaque origin
 *     with no network (D-69) — framed or opened top-level — and escaped Source;
 *   - Dismiss, Hide, Restore and Remove through the UI on a seeded flagged page,
 *     each checked in Postgres; Remove's `purge_after` is now + 30 days;
 *   - a child-sexual-abuse item: no bytes in the document, and none from either
 *     byte route without `?show=1`, until "Show"; an appeal on it rejected
 *     through the UI.
 *
 * NO MOCKS. Pages are published through `POST /api/sites` (real R2 + KV); the
 * flag, the scan row, the reports and the appeal are SEEDED rows — the scanner
 * and `/report` have their own specs. Mail goes to Resend's test inbox.
 *
 * KV (dev free plan): two publishes (2 writes), Hide / Restore / Remove (2
 * writes + 1 delete), cleanup (≤ 2 deletes) — about 7 operations a run.
 */

const RUN = crypto.randomUUID().slice(0, 8);
const ADMIN = process.env.KEPT_E2E_MODERATION_ADMIN_EMAIL!;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/**
 * The fixture's script (D-69): it writes into its own DOM, then probes what an
 * opaque origin must not reach — the embedding window and `app.`'s cookies.
 * Only "readable" / "reached" is ever written, never a value.
 */
const PROBE = `<p id="ran"></p><p id="top"></p><p id="cookie"></p><script>
document.getElementById("ran").textContent = "ran";
try { void parent.document.title; document.getElementById("top").textContent = parent === window ? "self" : "reached"; } catch (e) { document.getElementById("top").textContent = "blocked"; }
try { void document.cookie; document.getElementById("cookie").textContent = "readable"; } catch (e) { document.getElementById("cookie").textContent = "blocked"; }
</script>`;
const previewUrl = (siteId: string, shown = false) =>
  `/api/admin/moderation/sites/${siteId}/preview${shown ? "?show=1" : ""}`;
const ownerEmail = (ownerId: string) => `delivered+e07-011-owner-${RUN}-${ownerId.slice(0, 8)}@resend.dev`;

test.describe("the moderation screen (open)", () => {
  test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
  test.describe.configure({ mode: "serial", timeout: LIVE_STACK_TIMEOUT * 2 });

  const scope = newScope();
  const reportIds: string[] = [];
  const contexts: BrowserContext[] = [];

  test.beforeAll(async () => {
    if (SKIP_OWNER_UI) return;
    expect(ADMIN, "playwright.config.ts sets KEPT_E2E_MODERATION_ADMIN_EMAIL").toBeTruthy();
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_OWNER_UI) return;
    for (const context of contexts) await context.close();
    if (reportIds.length) await db.delete(schema.abuseReports).where(inArray(schema.abuseReports.id, reportIds));
    // `cleanup` takes the manifests, R2 objects, action rows, pending purges,
    // name holds, pages and both accounts (the admin's included).
    await cleanup(scope);
    await closeDb();
  });

  async function signedIn(browser: Browser, baseURL: string, email?: string) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    contexts.push(context);
    const page = await context.newPage();
    const { userId } = await signInAs(page, baseURL, scope, email);
    return { page, userId };
  }

  /** An owned page with real bytes, restricted by seeded rows as a scanner or report would have. */
  async function flaggedPage(
    owner: Page,
    ownerId: string,
    baseURL: string,
    flag: { status: "under_review" | "quarantined"; reason: "phishing" | "child_sexual_abuse" },
  ) {
    const marker = `e07-011-${RUN}-${flag.reason}`;
    const published = await publishOwned(owner, baseURL, scope, marker, `<h1 id="m">${marker}</h1>${PROBE}`);
    await db
      .update(schema.sites)
      .set({ status: flag.status, moderationReason: flag.reason })
      .where(eq(schema.sites.id, published.siteId));
    const site = await readSite(published.siteId);
    const [version] = await db
      .select()
      .from(schema.siteVersions)
      .where(eq(schema.siteVersions.id, site.currentVersionId!));
    await db.insert(schema.scans).values({
      siteId: site.id,
      versionId: version!.id,
      contentHash: version!.contentHash,
      trigger: "publish",
      status: "done",
      verdict: "flag",
      rule: "P1",
      reason: flag.reason,
      policyVersion: "e07-011-seed",
      model: "e07-011-seed",
      answers: { harm: 0.97 },
      facts: { secretField: true },
      completedAt: new Date(),
    });
    // The owner reads the statements in Resend's test inbox, not at `.invalid`.
    await db
      .update(schema.user)
      .set({ email: ownerEmail(ownerId) })
      .where(eq(schema.user.id, ownerId));
    return { ...published, marker };
  }

  async function seedReport(siteId: string, slug: string, details: string) {
    const [row] = await db
      .insert(schema.abuseReports)
      .values({
        siteId,
        slug,
        url: `https://${slug}.example`,
        category: "phishing",
        details,
        reporterEmail: `delivered+e07-011-reporter-${RUN}@resend.dev`,
        reporterBucket: `e07-011-${RUN}`,
      })
      .returning({ id: schema.abuseReports.id });
    reportIds.push(row!.id);
    return row!.id;
  }

  const actionsOf = (siteId: string) =>
    db.select().from(schema.moderationActions).where(eq(schema.moderationActions.siteId, siteId));

  async function decide(page: Page, testId: string, fill: { note?: string; reason?: string; understood?: boolean }) {
    await page.getByTestId(testId).click();
    const dialog = page.getByTestId(`${testId}-dialog`);
    await expect(dialog).toBeVisible();
    if (fill.reason) await dialog.getByTestId(`${testId}-reason`).selectOption(fill.reason);
    if (fill.note) await dialog.getByTestId(`${testId}-note`).fill(fill.note);
    if (fill.understood) await dialog.getByTestId(`${testId}-understood`).check();
    await dialog.getByTestId(`${testId}-dialog-confirm`).click();
    await expect(dialog).toBeHidden({ timeout: LIVE_STACK_TIMEOUT });
  }

  test("AC20: everyone but an admin gets the bare 404 — pages and every admin API", async ({
    browser,
    baseURL,
    request,
  }) => {
    const { page: stranger } = await signedIn(browser, baseURL!);
    const unknownPath = `/admin/e07-011-nothing-${RUN}`;
    expect((await request.get(unknownPath)).status()).toBe(404);
    // What a visitor SEES for an unknown path — Next's default not-found.
    await stranger.goto(unknownPath);
    const unknownText = await stranger.locator("body").innerText();
    expect(unknownText).toContain("This page could not be found.");

    for (const path of ["/admin/moderation", "/admin/moderation?tab=log", `/admin/moderation/site/${crypto.randomUUID()}`]) {
      expect((await request.get(path)).status(), `signed out: ${path}`).toBe(404);
      const signedInAnswer = await stranger.request.get(path);
      expect(signedInAnswer.status(), `non-admin: ${path}`).toBe(404);
      // The same screen as the unknown path: no shell, no sign-in, no "forbidden".
      const response = await stranger.goto(path);
      expect(response?.status()).toBe(404);
      await expect(stranger.getByText("This page could not be found.")).toBeVisible();
      expect(await stranger.locator("body").innerText(), path).toBe(unknownText);
    }

    const origin = { origin: new URL(baseURL!).origin };
    const id = crypto.randomUUID();
    const calls = [
      stranger.request.post(`/api/admin/moderation/sites/${id}`, { headers: origin, data: { action: "restore", note: "x" } }),
      stranger.request.post("/api/admin/moderation/reports", { headers: origin, data: { reportIds: [id], note: "x" } }),
      stranger.request.post(`/api/admin/moderation/appeals/${id}`, { headers: origin, data: { decision: "grant", note: "x" } }),
      stranger.request.get(`/api/admin/moderation/sites/${id}/source`),
      request.get(`/api/admin/moderation/sites/${id}/source`),
      stranger.request.get(previewUrl(id)),
      stranger.request.get(previewUrl(id, true)),
      request.get(previewUrl(id)),
    ];
    for (const response of await Promise.all(calls)) {
      expect(response.status(), response.url()).toBe(404);
      expect(await response.text(), response.url()).toBe("");
    }
  });

  test("AC20: /admin/* sends a strict CSP and hydrates under it; nothing else on app. gets one", async ({
    browser,
    baseURL,
  }) => {
    const { page: admin } = await signedIn(browser, baseURL!, ADMIN);
    const response = await admin.goto("/admin/moderation");
    expect(response?.status()).toBe(200);
    const csp = response!.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);

    // Hydrated: the tab bar is a client component; switching is a client push.
    await admin.getByTestId("tab-scanner").click();
    await expect(admin).toHaveURL(/tab=scanner/);
    await expect(admin.getByTestId("scanner-panel")).toBeVisible();
    await admin.getByTestId("tab-log").click();
    await expect(admin).toHaveURL(/tab=log/);

    const elsewhere = await admin.request.get("/dashboard");
    expect(elsewhere.status()).toBe(200);
    expect(elsewhere.headers()["content-security-policy"]).toBeUndefined();
  });

  test("AC20 + AC21: Dismiss, Hide, Restore and Remove from the item view, each landing in Postgres", async ({
    browser,
    baseURL,
  }) => {
    const owner = await signedIn(browser, baseURL!);
    const flagged = await flaggedPage(owner.page, owner.userId, baseURL!, { status: "under_review", reason: "phishing" });
    const dismissed = await seedReport(flagged.siteId, flagged.slug, `e07-011 ${RUN}: the first report, to dismiss.`);
    const actioned = await seedReport(flagged.siteId, flagged.slug, `e07-011 ${RUN}: the second report, actioned by Hide.`);
    const { page: admin } = await signedIn(browser, baseURL!, ADMIN);

    // Queue → item. The row names the owner.
    await admin.goto("/admin/moderation");
    await expect(admin.getByTestId(`queue-${flagged.siteId}`).getByTestId("row-owner")).toHaveText(ownerEmail(owner.userId));
    await admin.getByTestId(`queue-${flagged.siteId}`).click();
    await expect(admin).toHaveURL(`/admin/moderation/site/${flagged.siteId}`);
    await expect(admin.getByTestId("item-slug")).toHaveText(flagged.slug);
    await expect(admin.getByTestId("item-facts")).toContainText(ownerEmail(owner.userId));
    await expect(admin.getByTestId("item-facts")).toContainText("(studio)");
    await expect(admin.getByTestId("item-scan")).toContainText("P1");
    await expect(admin.getByTestId("item-scan")).toContainText("0.97");

    // The preview (D-69): a sandboxed frame on its own route, nothing else
    // granted; the page's script runs in it and reaches neither this window nor
    // `app.`'s cookies.
    const frame = admin.getByTestId("item-preview").locator("iframe");
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    await expect(frame).toHaveAttribute("src", previewUrl(flagged.siteId));
    expect(await frame.getAttribute("srcdoc")).toBeNull();
    const inFrame = admin.frameLocator('[data-testid="item-preview"] iframe');
    await expect(inFrame.locator("#m")).toHaveText(flagged.marker);
    await expect(inFrame.locator("#ran"), "the page's inline script ran").toHaveText("ran");
    await expect(inFrame.locator("#top"), "parent.document throws: opaque origin").toHaveText("blocked");
    await expect(inFrame.locator("#cookie"), "document.cookie throws: opaque origin").toHaveText("blocked");
    // A single-file page has no set to list.
    await expect(admin.getByTestId("item-files")).toHaveCount(0);

    // The route's own headers — and not the `/admin/*` policy on top of them.
    const preview = await admin.request.get(previewUrl(flagged.siteId));
    expect(preview.status()).toBe(200);
    const headers = preview.headers();
    expect(headers["content-security-policy"]).toBe(ADMIN_PREVIEW_CSP);
    expect(headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["cache-control"]).toBe("no-store");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(await preview.text()).toContain(flagged.marker);

    // Opened top-level, the same policy still sandboxes it: no cookie on `app.`.
    const direct = await admin.context().newPage();
    await direct.goto(previewUrl(flagged.siteId));
    await expect(direct.locator("#ran")).toHaveText("ran");
    await expect(direct.locator("#cookie")).toHaveText("blocked");
    await direct.close();
    // Source: escaped text — the markup is shown, not parsed.
    await admin.getByTestId("source-tab").click();
    await expect(admin.getByTestId("source-view")).toContainText(`<h1 id="m">${flagged.marker}</h1>`);
    await expect(admin.locator("#m")).toHaveCount(0);

    // Dismiss: the written reason is required.
    await admin.getByTestId("action-dismiss").click();
    await expect(admin.getByTestId("action-dismiss-dialog-confirm")).toBeDisabled();
    await admin.keyboard.press("Escape");
    await decide(admin, "action-dismiss", { note: "e07-011: both reports are about a demo." });
    await expect.poll(async () => (await db.select().from(schema.abuseReports).where(inArray(schema.abuseReports.id, [dismissed, actioned]))).map((r) => r.status).sort()).toEqual(["dismissed", "dismissed"]);
    // Both were open, so one Dismiss closed both; seed the one Hide will action.
    const forHide = await seedReport(flagged.siteId, flagged.slug, `e07-011 ${RUN}: a third report, actioned by Hide.`);
    expect((await actionsOf(flagged.siteId)).filter((a) => a.action === "dismiss_report")).toHaveLength(2);

    // Hide: a listed reason is required.
    await admin.reload();
    await decide(admin, "action-hide", { reason: "phishing", note: "e07-011 hide" });
    await expect.poll(async () => (await readSite(flagged.siteId)).status).toBe("quarantined");
    const [hidden] = await db.select().from(schema.abuseReports).where(eq(schema.abuseReports.id, forHide));
    expect(hidden!.status).toBe("actioned");

    // Restore: back to live, reason cleared — and no note needed (Arun 2026-10-19).
    await decide(admin, "action-restore", {});
    await expect.poll(async () => (await readSite(flagged.siteId)).status).toBe("live");
    expect((await readSite(flagged.siteId)).moderationReason).toBeNull();
    const restored = (await actionsOf(flagged.siteId)).find((a) => a.action === "restore");
    expect(restored?.note, "an empty note is stored as none").toBeNull();

    // Remove: confirmation required on top of the reason.
    await admin.getByTestId("action-remove").click();
    const removeDialog = admin.getByTestId("action-remove-dialog");
    await removeDialog.getByTestId("action-remove-reason").selectOption("spam");
    await expect(removeDialog.getByTestId("action-remove-dialog-confirm")).toBeDisabled();
    await removeDialog.getByTestId("action-remove-understood").check();
    await removeDialog.getByTestId("action-remove-dialog-confirm").click();
    await expect(removeDialog).toBeHidden({ timeout: LIVE_STACK_TIMEOUT });
    const removed = await readSite(flagged.siteId);
    expect(removed.status).toBe("removed");
    expect(removed.moderationReason).toBe("spam");
    expect(Math.abs(removed.purgeAfter!.getTime() - (Date.now() + DRAFT_GRACE_DAYS * MS_PER_DAY))).toBeLessThan(5 * 60_000);
    const [hold] = await db
      .select()
      .from(schema.nameHolds)
      .where(and(eq(schema.nameHolds.name, flagged.slug), eq(schema.nameHolds.siteId, flagged.siteId)));
    expect(hold?.reason, "D19: the name stays off the market").toBe("removed");

    const log = (await actionsOf(flagged.siteId)).map((a) => `${a.actor}:${a.action}`).sort();
    expect(log).toEqual(["admin:dismiss_report", "admin:dismiss_report", "admin:hide", "admin:remove", "admin:restore"]);

    // The screen says so too.
    await admin.reload();
    await expect(admin.getByTestId("item-status")).toHaveText("removed");
    await expect(admin.getByTestId("timeline-row")).toHaveCount(5);
  });

  test("AC39 (admin half): a child-sexual-abuse item has no bytes in the document until Show; its appeal is rejected with a reason", async ({
    browser,
    baseURL,
  }) => {
    const owner = await signedIn(browser, baseURL!);
    const csam = await flaggedPage(owner.page, owner.userId, baseURL!, { status: "quarantined", reason: "child_sexual_abuse" });
    const [appeal] = await db
      .insert(schema.appeals)
      .values({ siteId: csam.siteId, submittedByUserId: owner.userId, message: `e07-011 ${RUN}: this is my own test page.` })
      .returning({ id: schema.appeals.id });
    const { page: admin } = await signedIn(browser, baseURL!, ADMIN);

    // Pinned on top of the queue.
    await admin.goto("/admin/moderation");
    await expect(admin.locator('[data-testid^="queue-"]').first()).toHaveAttribute("data-testid", `queue-${csam.siteId}`);

    // Neither byte route answers without the Show intent, not even an admin.
    for (const path of [`/api/admin/moderation/sites/${csam.siteId}/source`, previewUrl(csam.siteId)]) {
      const refused = await admin.request.get(path);
      expect(refused.status(), path).toBe(404);
      expect(await refused.text(), path).toBe("");
    }

    let sourceFetches = 0;
    let previewFetches = 0;
    admin.on("request", (req) => {
      if (req.url().includes(`/api/admin/moderation/sites/${csam.siteId}/source`)) sourceFetches++;
      if (req.url().includes(`/api/admin/moderation/sites/${csam.siteId}/preview`)) previewFetches++;
    });
    await admin.goto(`/admin/moderation/site/${csam.siteId}`);
    await expect(admin.getByTestId("preview-hidden")).toBeVisible();
    await expect(admin.getByTestId("item-preview").locator("iframe")).toHaveCount(0);
    expect(await admin.content(), "no byte of the page in the render").not.toContain(csam.marker);
    expect(sourceFetches, "never prefetched").toBe(0);
    expect(previewFetches, "never framed").toBe(0);

    await admin.getByRole("button", { name: "Show" }).click();
    const frame = admin.getByTestId("item-preview").locator("iframe");
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    await expect(frame).toHaveAttribute("src", previewUrl(csam.siteId, true));
    expect(sourceFetches).toBe(1);
    const inFrame = admin.frameLocator('[data-testid="item-preview"] iframe');
    await expect(inFrame.locator("#m")).toHaveText(csam.marker);
    await expect(inFrame.locator("#ran")).toHaveText("ran");
    expect(previewFetches).toBe(1);

    await decide(admin, "action-reject", { note: "e07-011: the report stands." });
    const [decided] = await db.select().from(schema.appeals).where(eq(schema.appeals.id, appeal!.id));
    expect(decided!.status).toBe("rejected");
    expect(decided!.decisionNote).toBe("e07-011: the report stands.");
    expect((await readSite(csam.siteId)).status, "a rejection changes nothing").toBe("quarantined");
  });

  test("E08: a multi-file page lists its files under the preview, from Postgres — path, size and served type", async ({
    browser,
    baseURL,
  }) => {
    const owner = await signedIn(browser, baseURL!);
    const marker = `e08-hand-${RUN}-set`;
    const files = [
      { path: "index.html", content: `<!doctype html><title>${marker}</title><h1 id="m">${marker}</h1><script src="assets/app.js"></script>` },
      { path: "assets/app.js", content: `document.title = "${marker}";` },
      { path: "assets/data.json", content: `{"marker":"${marker}"}` },
    ];
    // Seeded rows and bytes, no manifest: nothing on the edge, no KV spent.
    const set = await seedOwnedSet(scope, owner.userId, files);
    await db
      .update(schema.sites)
      .set({ status: "under_review", moderationReason: "phishing" })
      .where(eq(schema.sites.id, set.siteId));

    const { page: admin } = await signedIn(browser, baseURL!, ADMIN);
    await admin.goto(`/admin/moderation/site/${set.siteId}`);

    // The preview is unchanged: the same sandboxed frame on the same route.
    const frame = admin.getByTestId("item-preview").locator("iframe");
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    await expect(frame).toHaveAttribute("src", previewUrl(set.siteId));
    await expect(admin.frameLocator('[data-testid="item-preview"] iframe').locator("#m")).toHaveText(marker);

    // …and beneath it, the whole set in path order, as `site_version_files` holds it.
    const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
    await expect(admin.getByTestId("item-files-summary")).toHaveText(fileSetSummary(files.length, total));
    const rows = admin.getByTestId("item-file");
    await expect(rows).toHaveCount(files.length);
    const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const [i, file] of sorted.entries()) {
      await expect(rows.nth(i)).toContainText(file.path);
      await expect(rows.nth(i)).toContainText(formatBytes(Buffer.byteLength(file.content)));
    }
    await expect(rows.filter({ hasText: "assets/app.js" })).toContainText("text/javascript; charset=utf-8");
    await expect(rows.filter({ hasText: "assets/data.json" })).toContainText("application/json; charset=utf-8");
  });
});
