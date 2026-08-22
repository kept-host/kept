import { expect, test, type APIRequestContext } from "@playwright/test";
import { eq } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import {
  deleteDraft,
  publishViaApi,
  SKIP_LIVE_PUBLISH,
  pageHtml,
} from "./live-publish";

/**
 * `sites.title` on the two KEYLESS write paths — E06 task 013, the half of
 * verification criterion **15a** nothing else covers.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * D5 requires the `<title>` to be extracted by ONE helper on **all four** paths
 * that write bytes, "because a title set on publish but not on replace makes the
 * dashboard confidently display the *previous* page's name, which is worse than
 * showing a slug". Task 001 wired all four. Only two were ever asserted:
 * `owner-publish-api.spec.ts:214` and `owner-replace-api.spec.ts:251` cover the
 * owned pair. The **anonymous** pair — `POST /api/publish` and
 * `POST /api/anon/:token/replace` — had no assertion anywhere, which is exactly
 * the asymmetry D5 names as the dangerous one, since a page published by an
 * agent and later replaced is the product's headline flow.
 *
 * ── AND THE FALLBACK, WHICH IS A CORRECT PERMANENT STATE ─────────────────────
 *
 * Extraction NEVER throws. A page with no `<title>`, an empty one, or one that
 * is only whitespace stores `null` and renders its slug — it does not fail to
 * publish. `0004` backfills nothing and the `?? slug` fallback is why it does
 * not need to.
 *
 * NO MOCKS: real publishes against the real dev stack, each one deleted again.
 *
 * SKIPS without dev credentials: CI runs fork PRs with no secrets.
 */
test.describe("page titles on the keyless write paths", () => {
  test.skip(!!SKIP_LIVE_PUBLISH, SKIP_LIVE_PUBLISH || undefined);
  test.describe.configure({ timeout: LIVE_STACK_TIMEOUT });

  test.beforeAll(async () => {
    if (SKIP_LIVE_PUBLISH) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_LIVE_PUBLISH) return;
    await closeDb();
  });

  /** Publish keylessly. Every caller deletes the draft again in a `finally`. */
  async function publish(
    request: APIRequestContext,
    html: string,
  ): Promise<{ siteId: string; slug: string; token: string }> {
    const response = await publishViaApi(request, html);
    expect(response.status(), await response.text()).toBe(201);
    const body = (await response.json()) as { slug: string; anonToken: string };

    const [row] = await db
      .select({ id: schema.sites.id })
      .from(schema.sites)
      .where(eq(schema.sites.slug, body.slug));
    expect(row, "a 201 must have written a row").toBeDefined();
    return { siteId: row!.id, slug: body.slug, token: body.anonToken };
  }

  const titleOf = async (siteId: string): Promise<string | null> => {
    const [row] = await db
      .select({ title: schema.sites.title })
      .from(schema.sites)
      .where(eq(schema.sites.id, siteId));
    return row?.title ?? null;
  };

  test("an anonymous publish stores its title, and an anonymous replace REPLACES it", async ({
    request,
  }) => {
    const first = `E06 anon title ${crypto.randomUUID().slice(0, 8)}`;
    const site = await publish(request, pageHtml(first));
    try {
      expect(await titleOf(site.siteId), "anon publish extracts the title").toBe(first);

      // THE ONE THAT MATTERS. A title populated on publish but not on replace
      // leaves the wall naming the page by its *previous* document — confidently,
      // and wrongly.
      const second = `E06 anon retitled ${crypto.randomUUID().slice(0, 8)}`;
      const replaced = await request.post(`/api/anon/${site.token}/replace`, {
        headers: { "content-type": "application/json" },
        data: { html: pageHtml(second) },
      });
      expect(replaced.status(), await replaced.text()).toBe(200);

      expect(
        await titleOf(site.siteId),
        "anon replace must RE-extract, never leave the old name in place",
      ).toBe(second);
    } finally {
      await deleteDraft(request, site.token);
    }
  });

  test("no title, an empty title and a whitespace-only title all store null and still publish", async ({
    request,
  }) => {
    const documents: [string, string][] = [
      ["no <title> element at all", "<!doctype html><html lang=\"en\"><body><h1>none</h1></body></html>"],
      ["an empty <title>", "<!doctype html><html lang=\"en\"><head><title></title></head><body><h1>empty</h1></body></html>"],
      [
        "a whitespace-only <title>",
        "<!doctype html><html lang=\"en\"><head><title>   \n\t </title></head><body><h1>blank</h1></body></html>",
      ],
    ];

    for (const [what, html] of documents) {
      // Marked so three otherwise-identical bodies are not deduped onto one page.
      const site = await publish(request, `${html}<!-- ${crypto.randomUUID()} -->`);
      try {
        // PUBLISHED, not refused: an unreadable title is a page with no title,
        // never a failed publish.
        expect(await titleOf(site.siteId), what).toBeNull();
        // …and `title ?? slug` is why `null` needs no backfill.
        expect(site.slug.length).toBeGreaterThan(0);
      } finally {
        await deleteDraft(request, site.token);
      }
    }
  });
});
