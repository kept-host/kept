import {
  limitsFor,
  nameChangeResultSchema,
  nameCheckResultSchema,
  studioErrorSchema,
} from "@kept/shared";
import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { pointerKey } from "../lib/storage/manifest";
import { pageObjectKey, r2Store } from "../lib/storage/r2";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import {
  probeEdge,
  STALE_EDGE_WINDOW_MS,
  urlsFor,
  waitForBytes,
  waitUntilGone,
} from "./live-publish";
import {
  cleanup,
  newScope,
  publishOwned,
  readSite,
  signInAs,
  SKIP_OWNER_UI,
} from "./owner-fixtures";

/**
 * AC18 + AC19 as ONE story on the real dev stack — E06 task 014's names drill.
 *
 * A free user renames a kept page to a name exactly the free minimum long; the
 * new URL serves the same bytes, the generated URL goes to the Worker's branded
 * 404 once the purge window has passed, and the R2 object never moves. Then the
 * name is renamed AWAY, which holds it: a second account (its own browser
 * context, its own session) checking it is told `taken` and cannot take it,
 * while its owner is told `held_for_you` and takes it back — and it serves the
 * owner's page again.
 *
 * `owner-rename-api.spec.ts` drills every refusal one by one; this file is the
 * sequence the epic's acceptance story walks, end to end, through the same
 * routes the Name field calls (`GET /api/names/check`, `PATCH /api/sites/:id/name`).
 *
 * NO MOCKS: pages are published through `POST /api/sites`, both users sign in
 * through the real magic-link verify, and the edge is probed over the network.
 * SKIPS without dev credentials.
 */

const FREE = limitsFor("free");

test.describe("the names drill (AC18, AC19)", () => {
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

  async function check(page: Page, baseURL: string, siteId: string, name: string) {
    const response = await page.request.get(
      `${baseURL}/api/names/check?${new URLSearchParams({ name, siteId })}`,
    );
    expect(response.status(), await response.text()).toBe(200);
    return nameCheckResultSchema.parse(await response.json());
  }

  const rename = (page: Page, baseURL: string, siteId: string, name: string) =>
    page.request.patch(`${baseURL}/api/sites/${siteId}/name`, {
      headers: sameOrigin(baseURL),
      data: { name },
    });

  async function renamed(page: Page, baseURL: string, siteId: string, name: string) {
    const response = await rename(page, baseURL, siteId, name);
    expect(response.status(), await response.text()).toBe(200);
    const { site } = nameChangeResultSchema.parse(await response.json());
    expect(site.slug).toBe(name);
    expect(site.nameKind).toBe("chosen");
    scope.slugs.add(name);
    return site;
  }

  /**
   * A name exactly `FREE.nameMinLength` letters long that the check calls
   * `available` — random, so a rerun never collides with its own leftovers;
   * re-drawn if the draw is taken, held or caught by the word filter.
   */
  async function freshShortName(page: Page, baseURL: string, siteId: string): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const letters = Array.from(crypto.getRandomValues(new Uint8Array(FREE.nameMinLength)), (byte) =>
        String.fromCharCode(97 + (byte % 26)),
      ).join("");
      if ((await check(page, baseURL, siteId, letters)).status === "available") return letters;
    }
    throw new Error("no available short name in 20 draws");
  }

  const statusOf = async (page: Page, baseURL: string, siteId: string, name: string) =>
    (await check(page, baseURL, siteId, name)).status;

  test("rename to a short chosen name: new URL serves, old URL is the branded 404, R2 never moved; the name held after a rename-away reads taken to another account and comes back to its owner", async ({
    page,
    browser,
    baseURL,
  }) => {
    // Three purge windows are waited out, each bounded by the architecture.
    test.setTimeout(LIVE_STACK_TIMEOUT + 4 * STALE_EDGE_WINDOW_MS);

    const owner = await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 names drill");
    expect(site.outcome).toBe("kept");
    const generated = site.slug;
    const { currentVersionId } = await readSite(site.siteId);
    const objectKey = pageObjectKey(site.siteId, currentVersionId!);
    await waitForBytes(urlsFor(generated)[0]!, site.html);

    // ── AC18: rename to a name of the free minimum length ──────────────────
    const short = await freshShortName(page, baseURL!, site.siteId);
    await renamed(page, baseURL!, site.siteId, short);
    for (const url of urlsFor(short)) await waitForBytes(url, site.html);
    for (const url of urlsFor(generated)) {
      await waitUntilGone(url);
      const gone = await probeEdge(url);
      expect(gone.status, url).toBe(404);
      expect(gone.body, `${url}: the Worker's branded 404`).toContain("Nothing kept here");
    }
    // A generated name is not held (D4): nothing reserves it now.
    expect(
      await db.select().from(schema.nameHolds).where(eq(schema.nameHolds.name, generated)),
    ).toEqual([]);
    // R2 never moved: objects are keyed by site id; one version, same bytes.
    expect(await r2Store().get(objectKey)).toBe(site.html);
    expect(
      await db
        .select({ id: schema.siteVersions.id })
        .from(schema.siteVersions)
        .where(eq(schema.siteVersions.siteId, site.siteId)),
    ).toHaveLength(1);

    // ── AC19: renaming AWAY from a chosen name holds it for its owner ──────
    const away = `e06-014-away-${crypto.randomUUID().slice(0, 8)}`;
    await renamed(page, baseURL!, site.siteId, away);
    const [hold] = await db.select().from(schema.nameHolds).where(eq(schema.nameHolds.name, short));
    expect(hold, "a chosen name renamed away is held").toBeDefined();
    expect(hold!.userId).toBe(owner.userId);
    expect(hold!.reason).toBe("renamed");
    for (const url of urlsFor(short)) await waitUntilGone(url);

    // A second account, in its own browser context with its own session.
    const strangerContext = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const stranger = await strangerContext.newPage();
      await signInAs(stranger, baseURL!, scope);
      const theirs = await publishOwned(stranger, baseURL!, scope, "E06 names stranger");
      const theirsBefore = await readSite(theirs.siteId);

      // Edge case 4: a hold reads as `taken`, and nothing reveals whose.
      expect(await statusOf(stranger, baseURL!, theirs.siteId, short)).toBe("taken");
      const refused = await rename(stranger, baseURL!, theirs.siteId, short);
      expect(refused.status(), await refused.text()).toBe(409);
      expect(studioErrorSchema.parse(await refused.json()).error.code).toBe("name_taken");
      expect(await readSite(theirs.siteId), "the refusal changed nothing").toEqual(theirsBefore);
    } finally {
      await strangerContext.close();
    }

    // The owner is told the truth, and takes it back.
    expect(await statusOf(page, baseURL!, site.siteId, short)).toBe("held_for_you");
    await renamed(page, baseURL!, site.siteId, short);
    for (const url of urlsFor(short)) await waitForBytes(url, site.html);
    expect(
      await db.select().from(schema.nameHolds).where(eq(schema.nameHolds.name, short)),
      "taking the name back ends its hold",
    ).toEqual([]);
    expect(await r2Store().get(pointerKey(short)), "the pointer names the page again").not.toBeNull();
    expect(await r2Store().get(objectKey), "still the same object").toBe(site.html);
    expect((await readSite(site.siteId)).slug).toBe(short);
  });
});
