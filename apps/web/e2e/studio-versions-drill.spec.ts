import { limitsFor, replaceResultSchema, restoreResultSchema } from "@kept/shared";
import { expect, test, type Page } from "@playwright/test";
import { desc, eq } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
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

/**
 * AC26 + AC28 as ONE sequence on the real dev stack — E06 task 014's versions
 * drill.
 *
 * A free page is replaced three times. After each replace the edge serves the
 * new bytes at the same URL; after the third, exactly `1 + previousVersions`
 * versions remain and every pruned version's object is gone from R2 (`get` is
 * null — `R2Store` has no `list` by design, contract §7.5; epic Risk 10). Then
 * Undo — a restore of the version the last replace named — serves the previous
 * bytes again while every page object stays exactly as it was: the same keys,
 * each holding its own bytes (AC28: no page-object write; the slug pointer is
 * the manifest, rewritten as the replace event).
 *
 * `owner-replace-api.spec.ts` and `owner-restore-api.spec.ts` drill each verb
 * and its refusals; this file chains them the way a person meets them.
 *
 * NO MOCKS. SKIPS without dev credentials.
 */

const FREE = limitsFor("free");

test.describe("the versions drill (AC26, AC28)", () => {
  test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);

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

  const sameOrigin = (baseURL: string) => ({ origin: new URL(baseURL).origin });

  /** Every version row, newest first — what the Versions tab lists. */
  const versionRows = (siteId: string) =>
    db
      .select({ id: schema.siteVersions.id, r2Key: schema.siteVersions.r2Key })
      .from(schema.siteVersions)
      .where(eq(schema.siteVersions.siteId, siteId))
      .orderBy(desc(schema.siteVersions.activatedAt), desc(schema.siteVersions.createdAt));

  async function replace(page: Page, baseURL: string, siteId: string, html: string) {
    const response = await page.request.post(`${baseURL}/api/sites/${siteId}/replace`, {
      headers: sameOrigin(baseURL),
      data: { html },
    });
    expect(response.status(), await response.text()).toBe(200);
    const body = replaceResultSchema.parse(await response.json());
    if (body.unchanged) throw new Error("new bytes must make a new version");
    return body;
  }

  test("three replaces on free leave current + previous with the pruned objects gone; Undo serves the previous bytes and writes no page object", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(LIVE_STACK_TIMEOUT + 5 * STALE_EDGE_WINDOW_MS);

    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 versions drill");
    const url = `https://${site.slug}.${servingDomain()}/`;
    await waitForBytes(url, site.html);

    // Every key that ever held a version of this page, and the bytes it held.
    const bytesByKey = new Map<string, string>();
    for (const row of await versionRows(site.siteId)) bytesByKey.set(row.r2Key, site.html);

    const htmls: string[] = [];
    let last: Awaited<ReturnType<typeof replace>> | undefined;
    for (const round of [1, 2, 3]) {
      const html = titledHtml(`E06 versions drill r${round} ${crypto.randomUUID().slice(0, 8)}`);
      last = await replace(page, baseURL!, site.siteId, html);
      htmls.push(html);
      for (const row of await versionRows(site.siteId)) {
        if (!bytesByKey.has(row.r2Key)) bytesByKey.set(row.r2Key, html);
      }
      // Same URL, new bytes — every round.
      await waitForBytes(url, html);
    }

    // ── AC26: current + the plan's previous versions; the rest pruned ───────
    const rows = await versionRows(site.siteId);
    expect(rows, "current + the free plan's previous versions").toHaveLength(1 + FREE.previousVersions);
    expect(rows[0]!.id).toBe(last!.versionId);
    expect(rows[1]!.id, "the Undo target is the one kept previous").toBe(last!.previousVersionId);
    const liveKeys = new Set(rows.map((row) => row.r2Key));
    const prunedKeys = [...bytesByKey.keys()].filter((key) => !liveKeys.has(key));
    expect(prunedKeys, "four versions written, two kept").toHaveLength(4 - rows.length);
    for (const key of prunedKeys) expect(await r2Store().get(key), `${key} pruned`).toBeNull();
    for (const row of rows) expect(await r2Store().get(row.r2Key)).toBe(bytesByKey.get(row.r2Key));

    // ── AC28: Undo is a restore — the pointer moves, no page object is written ─
    const response = await page.request.post(
      `${baseURL}/api/sites/${site.siteId}/versions/${last!.previousVersionId}/restore`,
      { headers: sameOrigin(baseURL!) },
    );
    expect(response.status(), await response.text()).toBe(200);
    const restored = restoreResultSchema.parse(await response.json());
    if (restored.unchanged) throw new Error("Undo must move the page");
    expect(restored.versionId).toBe(last!.previousVersionId);
    expect((await readSite(site.siteId)).currentVersionId).toBe(last!.previousVersionId);

    // Both remain listed; the same keys, each with its own bytes.
    const after = await versionRows(site.siteId);
    expect(after.map((row) => row.r2Key).sort()).toEqual(rows.map((row) => row.r2Key).sort());
    for (const row of after) expect(await r2Store().get(row.r2Key)).toBe(bytesByKey.get(row.r2Key));

    // And the edge serves the second replace's bytes again, at the same URL.
    const elapsed = await waitForBytes(url, htmls[1]!);
    expect(elapsed).toBeLessThanOrEqual(STALE_EDGE_WINDOW_MS);
  });
});
