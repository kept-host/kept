import {
  publishErrorSchema,
  replaceResultSchema,
  restoreResultSchema,
  studioErrorSchema,
} from "@kept/shared";
import { expect, test, type Page } from "@playwright/test";
import { desc, eq } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { pointerKey } from "../lib/storage/manifest";
import { r2Store } from "../lib/storage/r2";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { servingDomain, STALE_EDGE_WINDOW_MS, waitForBytes } from "./live-publish";
import {
  cleanup,
  newScope,
  publishOwned,
  readSite,
  signInAs,
  SKIP_OWNER_UI,
  titledHtml,
} from "./owner-fixtures";
import { jarlessContext } from "./session-request";

/**
 * `POST /api/sites/:id/versions/:versionId/restore` over the wire, against the
 * REAL dev stack — E06 task 007 (D7, AC25, AC28, AC44 for this route).
 *
 * NO MOCKS AND NO FIXTURE BYTES. Every page is published through
 * `POST /api/sites` and replaced through `POST /api/sites/:id/replace`, so the
 * versions a restore moves between are genuine R2 objects behind a genuine
 * pointer, KV manifest and edge cache.
 *
 * WHAT THIS FILE IS FOR:
 *
 *   1. **Undo, end to end (AC25).** Replace, wait until the edge serves the new
 *      bytes, restore the `previousVersionId` the replace answered with, and
 *      watch the edge serve the ORIGINAL bytes again at the same URL.
 *   2. **No page object is written (AC28).** Both versions stay listed and the
 *      set of object keys is identical before and after; each key still holds
 *      its own bytes. (`R2Store` has no `list` by design, so "keys" means the
 *      `site_versions` rows Postgres — the authority — holds.)
 *   3. **Every refusal moves nothing** — the current version (a no-op), another
 *      account's page, another page's version, a page under review, a
 *      signed-out call and a cross-origin one.
 *
 * SKIPS without dev credentials: CI runs on fork PRs with no secrets.
 */
test.describe("owner restore", () => {
  test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
  test.describe.configure({ timeout: LIVE_STACK_TIMEOUT });

  const scope = newScope();

  test.beforeAll(async () => {
    if (SKIP_OWNER_UI) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_OWNER_UI) return;
    await cleanup(scope);
    await closeDb();
  });

  const urlFor = (slug: string): string => `https://${slug}.${servingDomain()}/`;
  const sameOrigin = (baseURL: string) => ({ origin: new URL(baseURL).origin });

  const replace = (page: Page, baseURL: string, siteId: string, html: string) =>
    page.request.post(`${baseURL}/api/sites/${siteId}/replace`, {
      headers: sameOrigin(baseURL),
      data: { html },
    });

  const restore = (
    page: Page,
    baseURL: string,
    siteId: string,
    versionId: string,
    headers: Record<string, string> = sameOrigin(baseURL),
  ) =>
    page.request.post(`${baseURL}/api/sites/${siteId}/versions/${versionId}/restore`, {
      headers,
    });

  /** Replace, and require a NEW version back (narrowed, or the test fails). */
  async function replaced(page: Page, baseURL: string, siteId: string, html: string) {
    const response = await replace(page, baseURL, siteId, html);
    expect(response.status(), await response.text()).toBe(200);
    const body = replaceResultSchema.parse(await response.json());
    if (body.unchanged) throw new Error("expected a new version, got { unchanged: true }");
    return body;
  }

  /** Every version row, newest first by `activated_at` — what the Versions tab lists. */
  const versionRows = (siteId: string) =>
    db
      .select({ id: schema.siteVersions.id, r2Key: schema.siteVersions.r2Key })
      .from(schema.siteVersions)
      .where(eq(schema.siteVersions.siteId, siteId))
      .orderBy(desc(schema.siteVersions.activatedAt), desc(schema.siteVersions.createdAt));

  /** The slug pointer's bytes — byte-identical to the KV manifest by construction. */
  const pointer = (slug: string) => r2Store().get(pointerKey(slug));

  test("Undo after a replace serves the previous version again at the same URL, and writes no page object (AC25, AC28)", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(LIVE_STACK_TIMEOUT + 3 * STALE_EDGE_WINDOW_MS);

    await signInAs(page, baseURL!, scope);
    const owned = await publishOwned(page, baseURL!, scope, "Restore drill");
    const original = (await readSite(owned.siteId)).currentVersionId!;
    const url = urlFor(owned.slug);
    await waitForBytes(url, owned.html);

    const nextHtml = titledHtml(`Restore drill v2 ${crypto.randomUUID().slice(0, 8)}`);
    const replacement = await replaced(page, baseURL!, owned.siteId, nextHtml);
    expect(replacement.previousVersionId, "the Undo target").toBe(original);
    // The edge must really have moved on, or seeing the original bytes again
    // below would prove nothing.
    await waitForBytes(url, nextHtml);

    const rowsBefore = await versionRows(owned.siteId);
    const before = await readSite(owned.siteId);

    // ── Undo: restore the version that was current before the replace ──────
    const response = await restore(page, baseURL!, owned.siteId, replacement.previousVersionId!);
    expect(response.status(), await response.text()).toBe(200);
    const body = restoreResultSchema.parse(await response.json());
    if (body.unchanged) throw new Error("restoring a previous version must move the page");
    expect(body.versionId).toBe(original);
    expect(body.previousVersionId, "undo-the-undo is one more restore").toBe(replacement.versionId);
    expect(body.slug, "same URL").toBe(owned.slug);
    expect(body.title, "the restored bytes' title, not the replaced page's").toBe(owned.title);

    const row = await readSite(owned.siteId);
    expect(row.currentVersionId).toBe(original);
    expect(row.title).toBe(owned.title);
    expect(row.updatedAt.getTime(), "the OG card's cache key moves").toBeGreaterThan(
      before.updatedAt.getTime(),
    );
    expect(await pointer(owned.slug)).toContain(original);

    // AC28: both remain listed, no object key appeared or vanished, and each
    // still holds its own bytes.
    const rowsAfter = await versionRows(owned.siteId);
    expect(rowsAfter.map((version) => version.id)).toEqual([original, replacement.versionId]);
    expect(rowsAfter.map((version) => version.r2Key).sort()).toEqual(
      rowsBefore.map((version) => version.r2Key).sort(),
    );
    expect(await r2Store().get(rowsAfter[0]!.r2Key)).toBe(owned.html);
    expect(await r2Store().get(rowsAfter[1]!.r2Key)).toBe(nextHtml);

    // And the edge serves the original again — the Undo did what it says.
    const elapsed = await waitForBytes(url, owned.html);
    expect(elapsed).toBeLessThanOrEqual(STALE_EDGE_WINDOW_MS);
  });

  test("restoring the version already served is { unchanged: true } and writes nothing", async ({
    page,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const owned = await publishOwned(page, baseURL!, scope, "Restore no-op");
    const before = await readSite(owned.siteId);
    // The pointer carries `updatedAt: Date.now()`, so any manifest write changes it.
    const pointerBefore = await pointer(owned.slug);

    const response = await restore(page, baseURL!, owned.siteId, before.currentVersionId!);

    expect(response.status(), await response.text()).toBe(200);
    expect(restoreResultSchema.parse(await response.json())).toEqual({ unchanged: true });
    expect(await readSite(owned.siteId), "not even updated_at moved").toEqual(before);
    expect(await pointer(owned.slug), "no manifest write").toBe(pointerBefore);
  });

  test("every refusal moves nothing: another account, another page's version, under review, signed out, cross-origin (AC44)", async ({
    page,
    baseURL,
    browser,
  }) => {
    await signInAs(page, baseURL!, scope);
    const owned = await publishOwned(page, baseURL!, scope, "Restore refusals");
    const original = (await readSite(owned.siteId)).currentVersionId!;
    const replacement = await replaced(
      page,
      baseURL!,
      owned.siteId,
      titledHtml(`Restore refusals v2 ${crypto.randomUUID().slice(0, 8)}`),
    );
    const otherPage = await publishOwned(page, baseURL!, scope, "Restore neighbour");
    const otherVersion = (await readSite(otherPage.siteId)).currentVersionId!;
    const before = await readSite(owned.siteId);
    const pointerBefore = await pointer(owned.slug);

    // ── another account: the same 404 body as a page that does not exist ────
    const strangerContext = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const stranger = await strangerContext.newPage();
      await signInAs(stranger, baseURL!, scope);
      const theirs = await restore(stranger, baseURL!, owned.siteId, original);
      const absent = await restore(stranger, baseURL!, crypto.randomUUID(), original);
      expect(theirs.status()).toBe(404);
      expect(absent.status()).toBe(404);
      // Byte-identical: "not yours" must not be an existence oracle (D17).
      expect(await theirs.text()).toBe(await absent.text());
      expect(studioErrorSchema.parse(await theirs.json()).error.code).toBe("not_found");
    } finally {
      await strangerContext.close();
    }

    // ── a version of ANOTHER page, even the same owner's ────────────────────
    const foreignVersion = await restore(page, baseURL!, owned.siteId, otherVersion);
    expect(foreignVersion.status()).toBe(404);
    expect(studioErrorSchema.parse(await foreignVersion.json()).error.code).toBe(
      "version_not_found",
    );
    expect((await readSite(otherPage.siteId)).currentVersionId).toBe(otherVersion);

    // ── signed out ──────────────────────────────────────────────────────────
    const anonymous = await jarlessContext();
    try {
      const signedOut = await anonymous.post(
        `${baseURL}/api/sites/${owned.siteId}/versions/${original}/restore`,
        { headers: sameOrigin(baseURL!) },
      );
      expect(signedOut.status()).toBe(401);
      studioErrorSchema.parse(await signedOut.json());
    } finally {
      await anonymous.dispose();
    }

    // ── a REAL session cookie carrying a hosted page's origin (E05a) ────────
    const crossOrigin = await restore(page, baseURL!, owned.siteId, original, {
      origin: `https://${owned.slug}.${servingDomain()}`,
    });
    expect(crossOrigin.status()).toBe(403);
    // E05a's flat body, untouched — the gate runs before any studio code.
    expect(publishErrorSchema.parse(await crossOrigin.json()).error).toBe("invalid_request");

    expect(await readSite(owned.siteId), "none of the above moved the page").toEqual(before);
    expect(await pointer(owned.slug)).toBe(pointerBefore);
    expect(before.currentVersionId).toBe(replacement.versionId);

    // ── under review: the replace gate (§5.2) ───────────────────────────────
    // E06 renders this state and writes none of it, so the fixture sets it.
    await db
      .update(schema.sites)
      .set({ status: "under_review" })
      .where(eq(schema.sites.id, owned.siteId));
    const flagged = await readSite(owned.siteId);
    const underReview = await restore(page, baseURL!, owned.siteId, original);
    expect(underReview.status()).toBe(409);
    expect(studioErrorSchema.parse(await underReview.json()).error.code).toBe(
      "not_allowed_in_status",
    );
    expect(await readSite(owned.siteId)).toEqual(flagged);
    expect(await pointer(owned.slug)).toBe(pointerBefore);
  });
});
