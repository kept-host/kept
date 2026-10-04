import { readFileSync } from "node:fs";

import { DRAFT_GRACE_DAYS, DRAFT_TTL_DAYS, limitsFor, PAGE_TITLE_MAX_LENGTH } from "@kept/shared";
import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { lastVisitsSync } from "../lib/db/queries/visits";
import { qrMatrix, qrPath } from "../lib/qr/qr-code";
import {
  DEMOTE_NOTE,
  deletePageWarning,
  REPLACED_TOAST,
  UNDONE_TOAST,
} from "../lib/sites/display";
import { VISITS_EMPTY_NOTE, VISITS_PRIVACY_LINE, VISITS_UNAVAILABLE } from "../lib/sites/visits-view";

import { waitForBytes } from "./live-publish";
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
 * `/site/[id]` in a real browser, against the REAL dev stack — E06 task 012:
 * AC10 (this screen), AC17 (UI), AC25 (UI), AC34, AC36, AC37, AC38, Bug 4's
 * title half, the PRD §5.2 status matrix, and Epic Verification 12 (the route
 * is the page's id; `/site/{slug}` is gone).
 *
 * NO MOCKS. Every page is published through `POST /api/sites` by a real
 * magic-link session; every verb goes over the wire to the same origin-gated
 * route the screen calls; every assertion that matters re-reads Postgres. The
 * only rows written directly are states E06 renders and never writes — E07's
 * `under_review` / `quarantined` / `expired`, and the visits sync's daily rows
 * (task 009's sync is gated on a human credential).
 *
 * SKIPS without dev credentials: CI runs fork PRs with no secrets.
 */
const scope = newScope();
const FREE = limitsFor("free");
const PRO = limitsFor("premium");
const DAY = 24 * 60 * 60 * 1000;

/** Text a later epic owns. None of it may exist anywhere in this screen's DOM (AC10). */
const LATER_EPIC_TEXT: readonly RegExp[] = [
  /\bCredit\b/,
  /Share kit/i,
  /\bPassword\b/i,
  /referrers/i,
  /countries/i,
  /Made with/i,
  /Made on kept/i,
  /Founding/i,
  /€/,
  /opens later/i,
  /\bGenerate\b/,
  /\bRegenerate\b/,
  /\bRemix\b/i,
  /Show prompt/i,
  /\breport\b/i,
  /\bWall\b/,
  /\bReferrals\b/,
];

/** Every text node in the document except scripts and styles — hidden ones included. */
const domText = (page: Page) =>
  page.evaluate(() => {
    const body = document.body.cloneNode(true) as HTMLElement;
    body.querySelectorAll("script, style, noscript").forEach((node) => node.remove());
    return body.textContent ?? "";
  });

/**
 * AC10 for this screen: walk all three tabs (inactive panels are not mounted)
 * and assert no later-epic text, and that the tabs and the nav are exactly the
 * PRD's.
 */
async function expectNoLaterEpics(page: Page) {
  await expect(page.getByRole("tab")).toHaveText(["General", "Visits", "Versions"]);
  await expect(page.getByRole("link", { name: /^(Wall|Explore|Referrals)$/ })).toHaveCount(0);
  for (const tab of ["General", "Visits", "Versions"]) {
    await page.getByRole("tab", { name: tab }).click();
    const text = await domText(page);
    for (const pattern of LATER_EPIC_TEXT) {
      expect(text, `${tab}: ${pattern} belongs to a later epic`).not.toMatch(pattern);
    }
  }
  await page.getByRole("tab", { name: "General" }).click();
}

/** Open the screen and wait until it answers clicks (a tab switch needs hydration). */
async function openDetail(page: Page, siteId: string) {
  await page.goto(`/site/${siteId}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("tab", { name: "Versions" }).click();
  await expect(page.getByTestId("versions-panel")).toBeVisible();
  await page.getByRole("tab", { name: "General" }).click();
}

async function setStatus(siteId: string, status: "under_review" | "quarantined" | "expired") {
  await db.update(schema.sites).set({ status }).where(eq(schema.sites.id, siteId));
}

test.describe("the page detail screen", () => {
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

  test("a kept page is routed by its id; a slug, a malformed id and a stranger's id are the same not-found", async ({
    page,
    browser,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 detail");

    await openDetail(page, site.siteId);
    await expect(page.getByRole("heading", { level: 1, name: site.name })).toBeVisible();
    await expect(page.getByTestId("status-chip")).toHaveText("Live · Kept");
    await expect(page.getByTestId("link-chip")).toHaveText(new URL(site.liveUrl).host);
    // The preview is the sandboxed `srcdoc` frame (D17), never a navigation.
    const frame = page.locator("iframe");
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute("sandbox", "");
    // Kept and live: every verb is there.
    await expect(page.getByTestId("rename-start")).toBeVisible();
    await expect(page.getByTestId("demote-button")).toBeVisible();
    await expect(page.getByTestId("explore-toggle")).toBeEnabled();
    await expect(page.getByTestId("keep-button")).toHaveCount(0);
    await expectNoLaterEpics(page);

    // Epic Verification 12: the slug route is gone — a slug is not a UUID.
    for (const path of [`/site/${site.slug}`, "/site/not-a-uuid", `/site/${crypto.randomUUID()}`]) {
      await page.goto(path);
      await expect(page.getByTestId("site-not-found"), path).toHaveText(
        "This page doesn’t exist or isn’t yours.",
      );
    }

    // Another account asking for THIS id gets the identical answer.
    const strangerContext = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const stranger = await strangerContext.newPage();
      await signInAs(stranger, baseURL!, scope);
      await stranger.goto(`/site/${site.siteId}`);
      await expect(stranger.getByTestId("site-not-found")).toBeVisible();
      await expect(stranger.getByText(site.name)).toHaveCount(0);
    } finally {
      await strangerContext.close();
    }
  });

  test("AC36 + Bug 4: a title edit is the owner's and moves updated_at; a replace keeps it; clearing hands it back", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 titled");
    const before = await readSite(site.siteId);

    await openDetail(page, site.siteId);
    const input = page.getByTestId("title-input");
    const bar = page.getByTestId("save-bar");
    await expect(input).toHaveValue(site.title!);
    await expect(input).toHaveAttribute("maxlength", String(PAGE_TITLE_MAX_LENGTH));
    await expect(bar).toHaveCount(0);

    // dirty → Discard → clean
    await input.fill("Not this one");
    await expect(bar).toHaveAttribute("data-phase", "dirty");
    await expect(bar).toContainText("Unsaved changes");
    await bar.getByRole("button", { name: "Discard" }).click();
    await expect(input).toHaveValue(site.title!);
    await expect(bar).toHaveCount(0);

    // dirty → saving → "Saved."
    const ownerTitle = `Owner title ${crypto.randomUUID().slice(0, 6)}`;
    await input.fill(ownerTitle);
    await page.getByTestId("details-save").click();
    await expect(bar).toContainText("Saved.", { timeout: LIVE_STACK_TIMEOUT });
    await expect(page.getByRole("heading", { level: 1, name: ownerTitle })).toBeVisible({
      timeout: LIVE_STACK_TIMEOUT,
    });
    const saved = await readSite(site.siteId);
    expect(saved.title).toBe(ownerTitle);
    expect(saved.titleSource).toBe("owner");
    expect(
      saved.updatedAt.getTime(),
      "Bug 4: updated_at moves, so the OG card's ?v= changes",
    ).toBeGreaterThan(before.updatedAt.getTime());

    // A replace does not overwrite an owner title (D11).
    const replacedTitle = `From new bytes ${crypto.randomUUID().slice(0, 6)}`;
    const replaced = await page.request.post(`${baseURL}/api/sites/${site.siteId}/replace`, {
      headers: { origin: new URL(baseURL!).origin, "content-type": "text/html" },
      data: titledHtml(replacedTitle),
    });
    expect(replaced.status(), await replaced.text()).toBe(200);
    expect((await readSite(site.siteId)).title).toBe(ownerTitle);

    // Clearing hands the title back to the page's own <title> — the CURRENT
    // version's, i.e. the replacement's.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await input.fill("");
    await page.getByTestId("details-save").click();
    await expect(bar).toContainText("Saved.", { timeout: LIVE_STACK_TIMEOUT });
    await expect(input).toHaveValue(replacedTitle);
    const cleared = await readSite(site.siteId);
    expect(cleared.title).toBe(replacedTitle);
    expect(cleared.titleSource).toBe("html");
  });

  test("AC37 + Danger zone: the Explore choice is kept-only and survives demote → keep; demote warns before it writes", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 explore");

    await openDetail(page, site.siteId);
    const toggle = page.getByTestId("explore-toggle");
    await expect(page.getByText("List on Explore when it opens", { exact: true })).toBeVisible();
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await page.getByTestId("details-save").click();
    await expect(page.getByTestId("save-bar")).toContainText("Saved.", { timeout: LIVE_STACK_TIMEOUT });
    expect((await readSite(site.siteId)).listedPublic).toBe(true);

    // DEMOTE: the consequence on screen BEFORE anything is written.
    await page.getByTestId("demote-button").click();
    const dialog = page.getByTestId("demote-dialog");
    await expect(dialog).toContainText(DEMOTE_NOTE);
    await expect(dialog).toContainText(`This page gets a ${DRAFT_TTL_DAYS}-day countdown again.`);
    await expect(dialog).toContainText(/It expires on .+ unless you keep it again\./);
    expect((await readSite(site.siteId)).expiresAt, "the warning precedes the write").toBeNull();
    await page.getByTestId("demote-dialog-confirm").click();
    await expect(dialog).toBeHidden({ timeout: LIVE_STACK_TIMEOUT });
    await expect(page.getByText(`Made draft · ${DRAFT_TTL_DAYS} days left`)).toBeVisible();

    // A draft: the toggle is DISABLED (not absent), still showing the choice.
    await expect(page.getByTestId("status-chip")).toHaveText(/^Draft · /, { timeout: LIVE_STACK_TIMEOUT });
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("Keep this page first. Only kept pages that passed safety checks can be listed.")).toBeVisible();
    await expect(page.getByTestId("demote-button")).toHaveCount(0);

    // KEEP from the header (Keep / Swap… — below the limit, one click).
    await page.getByTestId("keep-button").click();
    await expect(page.getByTestId("status-chip")).toHaveText("Live · Kept", { timeout: LIVE_STACK_TIMEOUT });
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const row = await readSite(site.siteId);
    expect(row.expiresAt).toBeNull();
    expect(row.listedPublic, "D12: preserved through demote → keep").toBe(true);
  });

  test("Name and link: AC17 on a draft; on a kept page every refusal changes nothing, the warning comes first, and a lost race says taken", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 renamed");
    const neighbour = await publishOwned(page, baseURL!, scope, "E06 neighbour");

    // AC17 (UI): a draft gets the helper, not the button.
    const { expiresAt } = await demoteViaApi(page, baseURL!, neighbour.siteId);
    expect(expiresAt).not.toBeNull();
    await openDetail(page, neighbour.siteId);
    await expect(page.getByTestId("draft-name-note")).toHaveText(
      "Keep this page to give it a name. Drafts get a generated one.",
    );
    await expect(page.getByTestId("rename-start")).toHaveCount(0);
    await expectNoLaterEpics(page);
    await keepViaApi(page, baseURL!, neighbour.siteId);

    await openDetail(page, site.siteId);
    await expect(page.getByText(`Names · 0 of ${FREE.chosenNames} used`)).toBeVisible();
    const status = page.getByTestId("rename-status");

    async function propose(candidate: string) {
      await page.getByTestId("rename-input").fill(candidate);
      await expect(status).toHaveAttribute("data-phase", "resolved", { timeout: LIVE_STACK_TIMEOUT });
    }

    await page.getByTestId("rename-start").click();
    for (const [candidate, reason, copy] of [
      ["Not A Name!", "invalid", "Use lowercase letters, numbers and single hyphens."],
      ["settings", "reserved", "That name is reserved."],
      ["abc", "too_short", `Names need at least ${FREE.nameMinLength} characters.`],
      [neighbour.slug, "taken", "That name is taken."],
    ] as const) {
      await propose(candidate);
      await expect(status).toHaveAttribute("data-reason", reason);
      await expect(status).toContainText(copy);
      await expect(page.getByTestId("rename-save")).toBeDisabled();
    }
    // Four letters on Free: the locked row, no CTA.
    await propose("abcd");
    await expect(status).toHaveAttribute("data-reason", "pro_length");
    await expect(status).toContainText("— a Pro feature, locked");
    expect((await readSite(site.siteId)).slug, "no refusal changed anything").toBe(site.slug);

    // Accepted: the "is free" tick, then the warning BEFORE the write.
    const chosen = `e06-012-${crypto.randomUUID().slice(0, 8)}`;
    scope.slugs.add(chosen);
    await propose(chosen);
    await expect(status).toContainText(`${chosen}.${new URL(site.liveUrl).host.slice(site.slug.length + 1)} is free`);
    await page.getByTestId("rename-save").click();
    const dialog = page.getByTestId("rename-dialog");
    await expect(dialog).toContainText(
      `The old link ${new URL(site.liveUrl).host} stops working within about 2 minutes.`,
    );
    await expect(dialog, "a generated name is not held, so no hold is promised").not.toContainText("12 months");
    expect((await readSite(site.siteId)).slug).toBe(site.slug);
    await page.getByTestId("rename-dialog-confirm").click();
    const newHost = `${chosen}.${new URL(site.liveUrl).host.slice(site.slug.length + 1)}`;
    await expect(page.getByText(`Renamed. Your page is at ${newHost}.`)).toBeVisible({
      timeout: LIVE_STACK_TIMEOUT,
    });
    await expect(page.getByTestId("current-link")).toHaveText(newHost);
    // Routed by id: the screen did not move.
    expect(new URL(page.url()).pathname).toBe(`/site/${site.siteId}`);
    expect((await readSite(site.siteId)).slug).toBe(chosen);
    await expect(page.getByText(`Names · 1 of ${FREE.chosenNames} used`)).toBeVisible();

    // Race lost: the check says free, another page takes the name while the
    // dialog is open, and the save says taken with nothing changed.
    const contested = `e06-012-${crypto.randomUUID().slice(0, 8)}`;
    scope.slugs.add(contested);
    await page.getByTestId("rename-start").click();
    await propose(contested);
    await page.getByTestId("rename-save").click();
    await expect(page.getByTestId("rename-dialog")).toContainText("Nobody else can take that name for 12 months.");
    const taken = await page.request.patch(`${baseURL}/api/sites/${neighbour.siteId}/name`, {
      headers: { origin: new URL(baseURL!).origin },
      data: { name: contested },
    });
    expect(taken.status(), await taken.text()).toBe(200);
    await page.getByTestId("rename-dialog-confirm").click();
    await expect(status).toHaveAttribute("data-reason", "taken", { timeout: LIVE_STACK_TIMEOUT });
    await expect(status).toContainText("That name is taken.");
    expect((await readSite(site.siteId)).slug).toBe(chosen);
  });

  test("AC25 (UI): the first version says so; replace then Undo serves the previous version; identical bytes are a no-op; restore confirms", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(LIVE_STACK_TIMEOUT * 3);
    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 versions");
    const original = (await readSite(site.siteId)).currentVersionId;

    await openDetail(page, site.siteId);
    await page.getByRole("tab", { name: "Versions" }).click();
    const panel = page.getByTestId("versions-panel");
    await expect(panel.getByTestId("version-row")).toHaveCount(1);
    await expect(panel.getByTestId("first-version-note")).toHaveText(
      "This is the first version. Replace it and the old one stays here for undo.",
    );
    await expect(panel.getByText(`Keep ${PRO.previousVersions} versions with Pro`)).toBeVisible();
    await expect(panel.getByText("Studio")).toBeVisible();

    async function chooseFile(name: string, body: string) {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        panel.getByRole("button", { name: /Drop an \.html file/ }).click(),
      ]);
      await chooser.setFiles({ name, mimeType: "text/html", buffer: Buffer.from(body) });
    }

    // The bytes already served: "No changes", nothing written (AC27).
    await chooseFile("same.html", site.html);
    await expect(page.getByText("No changes — that's already the live version.")).toBeVisible({
      timeout: LIVE_STACK_TIMEOUT,
    });
    expect((await readSite(site.siteId)).currentVersionId).toBe(original);

    // New bytes: replaced, with Undo.
    await chooseFile("new.html", titledHtml(`E06 replaced ${crypto.randomUUID().slice(0, 8)}`));
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: REPLACED_TOAST });
    await expect(toast).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    const replaced = (await readSite(site.siteId)).currentVersionId;
    expect(replaced).not.toBe(original);
    await expect(panel.getByTestId("version-row")).toHaveCount(2, { timeout: LIVE_STACK_TIMEOUT });

    // Undo = restore of the version that was current, and the page SERVES it.
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText(UNDONE_TOAST)).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    expect((await readSite(site.siteId)).currentVersionId).toBe(original);
    await waitForBytes(site.liveUrl, site.html);

    // Restore the other one back, through the confirm.
    await expect(panel.locator('[data-current="true"]')).toHaveAttribute("data-version-id", original!, {
      timeout: LIVE_STACK_TIMEOUT,
    });
    await panel.getByTestId("restore-button").click();
    const dialog = page.getByTestId("restore-dialog");
    await expect(dialog).toContainText("goes live at the same link within about 2 minutes");
    expect((await readSite(site.siteId)).currentVersionId, "nothing before the confirm").toBe(original);
    await page.getByTestId("restore-dialog-confirm").click();
    await expect(page.getByText(/^Restored the version from /)).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
    expect((await readSite(site.siteId)).currentVersionId).toBe(replaced);
  });

  test("AC38: the downloaded SVG is the screen's QR path, and the 1024 px PNG reproduces the matrix module for module", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 share");
    const matrix = qrMatrix(site.liveUrl);

    await openDetail(page, site.siteId);
    const share = page.getByTestId("share-section");

    const [svgDownload] = await Promise.all([
      page.waitForEvent("download"),
      share.getByTestId("download-qr-svg").click(),
    ]);
    expect(svgDownload.suggestedFilename()).toBe(`${site.slug}-qr.svg`);
    const svg = readFileSync((await svgDownload.path())!, "utf8");
    const parsed = await page.evaluate((text) => {
      const doc = new DOMParser().parseFromString(text, "image/svg+xml");
      return {
        error: doc.querySelector("parsererror") !== null,
        root: doc.documentElement.nodeName,
        d: doc.querySelector("path")?.getAttribute("d") ?? null,
      };
    }, svg);
    expect(parsed.error, "the SVG is valid XML").toBe(false);
    expect(parsed.root).toBe("svg");
    expect(parsed.d, "the same geometry as qrPath(qrMatrix(pageUrl))").toBe(qrPath(matrix));

    const [pngDownload] = await Promise.all([
      page.waitForEvent("download"),
      share.getByTestId("download-qr-png").click(),
    ]);
    expect(pngDownload.suggestedFilename()).toBe(`${site.slug}-qr.png`);
    const png = readFileSync((await pngDownload.path())!);
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)], "IHDR: 1024 × 1024").toEqual([1024, 1024]);

    // Decoded by the browser's own PNG decoder, sampled at every module centre.
    const sampled = await page.evaluate(
      async ({ base64, size }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const cell = canvas.width / size;
        const rows: boolean[][] = [];
        for (let y = 0; y < size; y++) {
          const row: boolean[] = [];
          for (let x = 0; x < size; x++) {
            const px = Math.floor((x + 0.5) * cell);
            const py = Math.floor((y + 0.5) * cell);
            row.push(pixels[(py * canvas.width + px) * 4]! < 128);
          }
          rows.push(row);
        }
        return rows;
      },
      { base64: png.toString("base64"), size: matrix.size },
    );
    expect(sampled).toEqual(matrix.modules);

    // Download page → the owner's attachment route.
    await expect(share.getByTestId("download-page")).toHaveAttribute("href", `/api/sites/${site.siteId}/download`);
    const file = await page.request.get(`${baseURL}/api/sites/${site.siteId}/download`);
    expect(file.status()).toBe(200);
    expect(await file.text()).toBe(site.html);
  });

  test("AC34 (UI): seeded daily rows draw 30 bars and a total; 7 DAYS reads the same rows; no rows is never a bare 0", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const visited = await publishOwned(page, baseURL!, scope, "E06 visited");
    const quiet = await publishOwned(page, baseURL!, scope, "E06 quiet");
    const dayAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
    await db.insert(schema.pageViewsDaily).values([
      { siteId: visited.siteId, day: dayAgo(1), views: 12 },
      { siteId: visited.siteId, day: dayAgo(3), views: 30 },
      { siteId: visited.siteId, day: dayAgo(20), views: 8 },
    ]);

    await openDetail(page, visited.siteId);
    await page.getByRole("tab", { name: "Visits" }).click();
    const panel = page.getByTestId("visits-panel");
    await expect(panel.getByTestId("visits-bar")).toHaveCount(30);
    await expect(panel.getByTestId("visits-total")).toHaveText("50");
    await panel.getByRole("button", { name: "7 days" }).click();
    await expect(panel.getByTestId("visits-bar")).toHaveCount(7);
    await expect(panel.getByTestId("visits-total")).toHaveText("42");
    await expect(panel.getByText(VISITS_PRIVACY_LINE)).toBeVisible();
    await expect(panel.getByText(/views?\b/i)).toHaveCount(0);

    // A page with no rows: "—" and the explainer — or, when the sync has only
    // ever failed, "not available". The real job row decides which; this spec
    // never writes it (the deployed dev stack reads it).
    const sync = await lastVisitsSync();
    await openDetail(page, quiet.siteId);
    await page.getByRole("tab", { name: "Visits" }).click();
    await expect(page.getByTestId("visits-total")).toHaveCount(0);
    await expect(page.getByTestId("visits-state")).toHaveText(
      sync.lastSuccessAt === null && sync.lastError !== null ? VISITS_UNAVAILABLE : VISITS_EMPTY_NOTE,
    );
    await expect(page.getByTestId("visits-empty")).toContainText("—");
  });

  test("Delete: the type-the-name gate and PRD §11's sentence, no Undo, then the archived reduced view", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 delete me");

    await openDetail(page, site.siteId);
    await page.getByTestId("delete-button").click();
    const dialog = page.getByTestId("delete-dialog");
    await expect(dialog).toContainText(`Delete ${site.name}?`);
    await expect(dialog).toContainText(deletePageWarning(null));
    await expect(dialog).toContainText(`You can download the files for ${DRAFT_GRACE_DAYS} days.`);
    const confirm = page.getByTestId("delete-dialog-confirm");
    await expect(confirm).toBeDisabled();
    await page.getByTestId("delete-gate").fill("not the name");
    await expect(confirm).toBeDisabled();
    await page.getByTestId("delete-gate").fill(site.slug);
    expect((await readSite(site.siteId)).status, "nothing before the confirm").toBe("live");
    await confirm.click();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: LIVE_STACK_TIMEOUT });
    await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
    expect((await readSite(site.siteId)).status).toBe("archived");

    // Archived: reachable by its id until purge_after, reduced to the download.
    await page.goto(`/site/${site.siteId}`);
    await expect(page.getByTestId("archived-notice")).toHaveText(
      /^Deleted on \d{1,2} \w{3,4} \d{4}\. You can download it until \d{1,2} \w{3,4} \d{4}\.$/,
    );
    await expect(page.getByTestId("download-page")).toHaveAttribute("href", `/api/sites/${site.siteId}/download`);
    await expect(page.getByRole("tab")).toHaveCount(0);
  });

  test("the status matrix: under review, quarantined and expired show only what PRD §5.2 allows; the appeal is a mailto naming the page", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 flagged");
    const host = new URL(site.liveUrl).host;

    // ── under_review: view, title, download, delete.
    await setStatus(site.siteId, "under_review");
    await openDetail(page, site.siteId);
    await expect(page.getByTestId("status-chip")).toHaveText("Under review");
    const banner = page.getByTestId("review-banner");
    await expect(banner).toContainText("This page is under review.");
    const appeal = banner.getByTestId("appeal-link");
    await expect(appeal).toHaveText("Appeal this review");
    const href = await appeal.getAttribute("href");
    expect(href).toMatch(/^mailto:abuse@kept\.host\?subject=/);
    expect(decodeURIComponent(href!.split("subject=")[1]!)).toContain(host);
    await expect(page.getByTestId("title-input")).toBeVisible();
    await expect(page.getByTestId("explore-toggle")).toBeDisabled();
    await expect(page.getByText("Paused while this page is under review.")).toBeVisible();
    await expect(page.getByTestId("rename-start")).toHaveCount(0);
    await expect(page.getByTestId("demote-button")).toHaveCount(0);
    await expect(page.getByTestId("delete-button")).toBeVisible();
    await expect(page.getByTestId("download-qr-svg")).toBeVisible();
    await expect(page.getByTestId("download-page")).toBeVisible();
    await page.getByRole("tab", { name: "Versions" }).click();
    await expect(page.getByTestId("restore-button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Drop an \.html file/ })).toHaveCount(0);
    await page.getByRole("tab", { name: "General" }).click();
    await expectNoLaterEpics(page);

    // ── quarantined: download, delete — and the banner.
    await setStatus(site.siteId, "quarantined");
    await openDetail(page, site.siteId);
    await expect(page.getByTestId("review-banner")).toBeVisible();
    await expect(page.getByTestId("title-input")).toHaveCount(0);
    await expect(page.getByTestId("explore-toggle")).toBeDisabled();
    await expect(page.getByTestId("download-qr-svg")).toHaveCount(0);
    await expect(page.getByTestId("download-page")).toBeVisible();
    await expect(page.getByTestId("delete-button")).toBeVisible();
    await expect(page.getByTestId("rename-start")).toHaveCount(0);
    await expect(page.getByTestId("keep-button")).toHaveCount(0);

    // ── expired in grace (a draft): keep (late), download, delete.
    await db
      .update(schema.sites)
      .set({
        status: "expired",
        expiresAt: new Date(Date.now() - DAY),
        purgeAfter: new Date(Date.now() + (DRAFT_GRACE_DAYS - 1) * DAY),
      })
      .where(eq(schema.sites.id, site.siteId));
    await openDetail(page, site.siteId);
    await expect(page.getByTestId("status-chip")).toHaveText("Draft · expired");
    await expect(page.getByTestId("keep-button")).toBeVisible();
    await expect(page.getByTestId("title-input")).toHaveCount(0);
    await expect(page.getByTestId("review-banner")).toHaveCount(0);
    await expect(page.getByTestId("delete-button")).toBeVisible();
    await expect(page.getByTestId("download-page")).toBeVisible();

    expect((await readSite(site.siteId)).status, "rendering a state must not change it").toBe("expired");
  });

  test("the screen paints from tokens, so it is correct in dark too", async ({ page, baseURL }) => {
    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 detail dark");

    await openDetail(page, site.siteId);
    await waitForTokensApplied(page);
    // Stamped imperatively, exactly as `auth-screen` and `smoke` do it: v1 pins
    // `forcedTheme="light"`, so this is the only way to reach the dark block.
    const section = page.getByTestId("details-section");
    const light = await section.evaluate((node) => getComputedStyle(node).backgroundColor);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    const dark = await section.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(dark, "the cards repaint from tokens in dark").not.toBe(light);
  });
});

/** Demote through the real route — a setup step for the screen under test. */
async function demoteViaApi(page: Page, baseURL: string, siteId: string) {
  const response = await page.request.post(`${baseURL}/api/sites/${siteId}/demote`, {
    headers: { origin: new URL(baseURL).origin },
  });
  expect(response.status(), await response.text()).toBe(200);
  return readSite(siteId);
}

async function keepViaApi(page: Page, baseURL: string, siteId: string) {
  const response = await page.request.post(`${baseURL}/api/sites/${siteId}/keep`, {
    headers: { origin: new URL(baseURL).origin },
  });
  expect(response.status(), await response.text()).toBe(200);
}
