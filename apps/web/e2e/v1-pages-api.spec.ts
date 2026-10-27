import {
  keyedDeleteResponseSchema,
  keyedErrorSchema,
  keyedListResponseSchema,
  keyedPageSchema,
  keyedPublishResponseSchema,
  uploadResponseSchema,
} from "@kept/shared";
import { expect, test } from "@playwright/test";
import { inArray } from "drizzle-orm";

import { createKey, revokeKey } from "../lib/agents/keys";
import { closeDb, db, schema } from "../lib/db";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { cleanup, newScope, signInAs, SKIP_OWNER_UI, titledHtml } from "./owner-fixtures";

/**
 * Keyed REST `/api/v1/pages` over HTTP against the REAL dev stack — E09 task
 * 008, D8, AC7.
 *
 * ONE page: publish → get → list → replace → delete, then the refusals —
 * a session cookie alone is 401, a revoked key is 401. Plus one presigned
 * upload (`/api/v1/uploads`, Q5), which writes nothing to KV.
 *
 * 3 KV-writing calls (publish, replace, delete).
 *
 * ⚠️ NO KEY OR `upload_url` IS PRINTED: assertions on them are booleans whose
 * messages do not carry them.
 *
 * SKIPS without dev credentials.
 */
const scope = newScope();
const buckets: string[] = [];

test.describe("keyed REST /api/v1/pages", () => {
  test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
  test.describe.configure({ mode: "serial", timeout: LIVE_STACK_TIMEOUT });

  test.beforeAll(async () => {
    if (SKIP_OWNER_UI) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_OWNER_UI) return;
    await cleanup(scope);
    if (buckets.length > 0) await db.delete(schema.rateLimits).where(inArray(schema.rateLimits.bucket, buckets));
    await closeDb();
  });

  test("publish → get → list → replace → delete on one page; cookie-only and revoked keys are 401", async ({
    page,
    request,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    const created = await createKey(userId, "v1 drill");
    expect(created, "a key was minted").not.toBeNull();
    const { summary, apiKey } = created!;
    buckets.push(`key:${summary.id}`, `uploads:${userId}`);
    const auth = { authorization: `Bearer ${apiKey}` };

    // A session cookie alone — the signed-in browser's own jar — is never a key.
    for (const response of [
      await page.request.get(`${baseURL}/api/v1/pages`),
      await page.request.post(`${baseURL}/api/v1/pages`, { data: { html: titledHtml("cookie only") } }),
    ]) {
      expect(response.status(), response.url()).toBe(401);
      expect(keyedErrorSchema.parse(await response.json()).error).toBe("unauthorized");
    }

    const published = await request.post("/api/v1/pages", {
      headers: { ...auth, "x-kept-client": "e09/v1-spec" },
      data: { html: titledHtml("v1 keyed page"), model: "drill-model" },
    });
    expect(published.status(), await published.text()).toBe(201);
    const body = keyedPublishResponseSchema.parse(await published.json());
    scope.slugs.add(body.slug);
    expect(body.kept).toBe(true);
    expect(body.expires_at).toBeNull();
    expect(body).not.toHaveProperty("claim_url");
    expect(new URL(body.studio_url).pathname).toMatch(/^\/site\/[0-9a-f-]{36}$/);

    const got = await request.get(`/api/v1/pages/${body.slug}`, { headers: auth });
    expect(got.status()).toBe(200);
    const page1 = keyedPageSchema.parse(await got.json());
    expect([page1.title, page1.model, page1.kept]).toEqual(["v1 keyed page", "drill-model", true]);

    const listed = await request.get("/api/v1/pages", { headers: auth });
    expect(listed.status()).toBe(200);
    const list = keyedListResponseSchema.parse(await listed.json());
    expect(list.pages.map((p) => p.slug)).toEqual([body.slug]);
    expect(list.next_cursor).toBeNull();

    const replaced = await request.put(`/api/v1/pages/${body.slug}`, {
      headers: auth,
      data: { html: titledHtml("v1 keyed page, replaced") },
    });
    expect(replaced.status(), await replaced.text()).toBe(200);
    expect(keyedPublishResponseSchema.parse(await replaced.json()).slug).toBe(body.slug);
    const reread = keyedPageSchema.parse(await (await request.get(`/api/v1/pages/${body.slug}`, { headers: auth })).json());
    expect(reread.title).toBe("v1 keyed page, replaced");

    const upload = await request.post("/api/v1/uploads", { headers: auth, data: { size_bytes: 4096 } });
    expect(upload.status()).toBe(200);
    expect(uploadResponseSchema.safeParse(await upload.json()).success, "a presigned upload").toBe(true);

    const deleted = await request.delete(`/api/v1/pages/${body.slug}`, { headers: auth });
    expect(deleted.status(), await deleted.text()).toBe(200);
    expect(keyedDeleteResponseSchema.parse(await deleted.json())).toEqual({ slug: body.slug, deleted: true });
    const gone = await request.get(`/api/v1/pages/${body.slug}`, { headers: auth });
    expect(gone.status()).toBe(404);
    expect(keyedErrorSchema.parse(await gone.json()).error).toBe("not_found");

    expect(await revokeKey(userId, summary.id)).toBe(true);
    const revoked = await request.get("/api/v1/pages", { headers: auth });
    expect(revoked.status()).toBe(401);
    expect(keyedErrorSchema.parse(await revoked.json()).error).toBe("unauthorized");
  });
});
