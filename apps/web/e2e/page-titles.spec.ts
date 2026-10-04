import {
  PAGE_TITLE_MAX_LENGTH,
  ownedPublishResultSchema,
  replaceResultSchema,
} from "@kept/shared";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { eq } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { deleteDraft, publishViaApi, SKIP_LIVE_PUBLISH } from "./live-publish";
import { cleanup, newScope, signInAs, SKIP_OWNER_UI } from "./owner-fixtures";

/**
 * `sites.title` over the wire, on the paths that write bytes — D11, PRD §5.9,
 * acceptance criterion **30** (E06 task 005).
 *
 * THE RULES, each asserted against the row Postgres actually holds:
 *
 *   · The title is the document's first `<title>`, entity-decoded, TAG-STRIPPED,
 *     whitespace-collapsed and capped at `PAGE_TITLE_MAX_LENGTH` code points.
 *   · A replace REFRESHES a title that came from the HTML…
 *   · …and NEVER overwrites one the owner set (`title_source = 'owner'`).
 *   · No `<title>`, an empty one or a blank one stores `null` and still
 *     publishes — `title ?? slug` is the name, so that is a correct state.
 *
 * Two families: the KEYLESS pair (`POST /api/publish`, `POST /api/anon/:token/
 * replace`) needs only the stores; the STUDIO pair (`POST /api/sites`,
 * `POST /api/sites/:id/replace`) also needs a session. The owner title is set
 * by a direct row update — the PATCH that sets it is task 012's.
 *
 * NO MOCKS: real publishes against the real dev stack, each one removed again.
 * SKIPS without dev credentials: CI runs fork PRs with no secrets.
 */
test.describe("page titles", () => {
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

  const doc = (title: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${crypto.randomUUID()}</h1></body></html>\n`;

  const runId = () => `e06-005-${crypto.randomUUID().slice(0, 8)}`;

  /** Publish keylessly. Every caller deletes the draft again in a `finally`. */
  async function publish(
    request: APIRequestContext,
    html: string,
  ): Promise<{ siteId: string; token: string }> {
    const response = await publishViaApi(request, html);
    expect(response.status(), await response.text()).toBe(201);
    const body = (await response.json()) as { slug: string; anonToken: string };

    const [row] = await db
      .select({ id: schema.sites.id })
      .from(schema.sites)
      .where(eq(schema.sites.slug, body.slug));
    expect(row, "a 201 must have written a row").toBeDefined();
    return { siteId: row!.id, token: body.anonToken };
  }

  const titleOf = async (siteId: string) => {
    const [row] = await db
      .select({ title: schema.sites.title, titleSource: schema.sites.titleSource })
      .from(schema.sites)
      .where(eq(schema.sites.id, siteId));
    expect(row, `site ${siteId} vanished`).toBeDefined();
    return row!;
  };

  /** What task 012's PATCH will do: the owner names the page. */
  const nameByOwner = (siteId: string, title: string) =>
    db
      .update(schema.sites)
      .set({ title, titleSource: "owner" })
      .where(eq(schema.sites.id, siteId));

  test("keyless: the title is decoded and tag-stripped, a replace refreshes it, and an owner title survives a replace", async ({
    request,
  }) => {
    const id = runId();
    const site = await publish(request, doc(`${id} &amp; <b>Jerry</b>\n\t  show`));
    try {
      expect(await titleOf(site.siteId)).toEqual({
        title: `${id} & Jerry show`,
        titleSource: "html",
      });

      // A title populated on publish but not on replace leaves the wall naming
      // the page by its *previous* document — confidently, and wrongly.
      const next = runId();
      const replaced = await request.post(`/api/anon/${site.token}/replace`, {
        headers: { "content-type": "application/json" },
        data: { html: doc(next) },
      });
      expect(replaced.status(), await replaced.text()).toBe(200);
      expect((await titleOf(site.siteId)).title, "an html title is refreshed").toBe(next);

      // …but a name the OWNER chose is theirs, and no replace may take it.
      await nameByOwner(site.siteId, "Named by its owner");
      const again = await request.post(`/api/anon/${site.token}/replace`, {
        headers: { "content-type": "application/json" },
        data: { html: doc(runId()) },
      });
      expect(again.status(), await again.text()).toBe(200);
      expect(await titleOf(site.siteId)).toEqual({
        title: "Named by its owner",
        titleSource: "owner",
      });
    } finally {
      await deleteDraft(request, site.token);
    }
  });

  test(`a long title is capped at ${PAGE_TITLE_MAX_LENGTH} code points, emoji and RTL included`, async ({
    request,
  }) => {
    for (const unit of ["a", "😀", "ש"]) {
      const site = await publish(request, doc(unit.repeat(PAGE_TITLE_MAX_LENGTH + 40)));
      try {
        const { title } = await titleOf(site.siteId);
        expect(title, unit).toBe(unit.repeat(PAGE_TITLE_MAX_LENGTH));
        expect(Array.from(title!).length, unit).toBe(PAGE_TITLE_MAX_LENGTH);
      } finally {
        await deleteDraft(request, site.token);
      }
    }
  });

  test("no title, an empty title and a whitespace-only title all store null and still publish", async ({
    request,
  }) => {
    const documents: [string, string][] = [
      ["no <title> element at all", `<!doctype html><html lang="en"><body><h1>${runId()}</h1></body></html>`],
      ["an empty <title>", doc("")],
      ["a whitespace-only <title>", doc("   \n\t ")],
      ["a tag-only <title>", doc("<b></b> <i> </i>")],
    ];

    for (const [what, html] of documents) {
      const site = await publish(request, html);
      try {
        // PUBLISHED, not refused: an unreadable title is a page with no title,
        // never a failed publish.
        expect((await titleOf(site.siteId)).title, what).toBeNull();
      } finally {
        await deleteDraft(request, site.token);
      }
    }
  });

  test("studio: POST /api/sites takes the title, a replace refreshes it, and an owner title survives a replace", async ({
    page,
    baseURL,
  }) => {
    test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
    const scope = newScope();
    try {
      await signInAs(page, baseURL!, scope);
      const headers = { origin: new URL(baseURL!).origin, "content-type": "application/json" };

      const id = runId();
      const published = await page.request.post(`${baseURL}/api/sites`, {
        headers,
        data: { html: doc(`<em>${id}</em> &lt;studio&gt;`) },
      });
      expect(published.status(), await published.text()).toBe(201);
      const { site } = ownedPublishResultSchema.parse(await published.json());
      scope.siteIds.push(site.id);
      scope.slugs.add(site.slug);
      // `&lt;studio&gt;` decodes to a tag — and a tag is stripped, never stored.
      expect(site.title).toBe(id);
      expect(await titleOf(site.id)).toEqual({ title: id, titleSource: "html" });

      const replace = (html: string) =>
        page.request.post(`${baseURL}/api/sites/${site.id}/replace`, { headers, data: { html } });

      const next = runId();
      const refreshed = await replace(doc(next));
      expect(refreshed.status(), await refreshed.text()).toBe(200);
      expect(replaceResultSchema.parse(await refreshed.json())).toMatchObject({
        unchanged: false,
        title: next,
      });
      expect((await titleOf(site.id)).title).toBe(next);

      await nameByOwner(site.id, "My own name");
      const kept = await replace(doc(runId()));
      expect(kept.status(), await kept.text()).toBe(200);
      expect(
        replaceResultSchema.parse(await kept.json()),
        "the response reports the title the row kept",
      ).toMatchObject({ unchanged: false, title: "My own name" });
      expect(await titleOf(site.id)).toEqual({ title: "My own name", titleSource: "owner" });
    } finally {
      await cleanup(scope);
    }
  });
});
