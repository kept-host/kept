import {
  limitsFor,
  ownedPublishResultSchema,
  publishErrorSchema,
  replaceResultSchema,
  studioErrorSchema,
  UPLOAD_CONTENT_TYPE,
  uploadResponseSchema,
  type UploadResponse,
} from "@kept/shared";
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { downloadZip } from "client-zip";
import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { siteObjectKeys, versionFiles } from "../lib/db/queries/version-files";
import { r2Store, siteObjectKey } from "../lib/storage/r2";
import { uploadMaxBytes, uploadObjectKey } from "../lib/uploads/upload";

import { pageHtml, publishViaApi } from "./live-publish";
import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { cleanup, newScope, signInAs, SKIP_OWNER_UI } from "./owner-fixtures";
import { jarlessContext } from "./session-request";

/**
 * Presigned uploads over the wire (E08 D5, task 009) — AC33, AC34 and AC1's
 * route half, against the REAL dev stack: real sessions through the real
 * magic-link verify, real presigned PUTs to dev R2 (sent from Node, which needs
 * no bucket CORS rule — the browser PUT is task 010's), real publishes.
 *
 * KV BUDGET (dev KV is on the free plan): an owned publish, its replace and
 * one keyless draft write a manifest each; `cleanup` removes two. Every other request here is refused,
 * or answers `200 duplicate`, before any store is written.
 *
 * Never prints an upload URL — it is a bearer credential until it expires.
 * SKIPS without dev credentials (CI on fork PRs).
 */
config({ path: ".env.local", quiet: true });

/** AC1's three-file fixture: an entry, a script and a real 1×1 PNG. */
const INDEX = "<!doctype html><title>E08 upload</title><script src=assets/app.js></script><img src=assets/logo.png>";
const APP = `console.log("kept ${crypto.randomUUID()}");`;
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const FILES: Record<string, string | Uint8Array<ArrayBuffer>> = { "index.html": INDEX, "assets/app.js": APP, "assets/logo.png": PNG };

async function zipOf(files: Record<string, string | Uint8Array>): Promise<Buffer> {
  const response = downloadZip(
    Object.entries(files).map(([name, input]) => ({ name, input, lastModified: new Date(0) })),
  );
  return Buffer.from(await response.arrayBuffer());
}

/** PUT `body` to a presigned URL with the signed type; the status only. */
async function putTo(upload: UploadResponse, body: Uint8Array): Promise<number> {
  const res = await fetch(upload.upload_url, {
    method: "PUT",
    headers: { "content-type": UPLOAD_CONTENT_TYPE },
    body: new Uint8Array(body),
  });
  await res.body?.cancel();
  return res.status;
}

test.describe("presigned uploads (D5)", () => {
  test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
  test.describe.configure({ timeout: LIVE_STACK_TIMEOUT * 2 });

  const scope = newScope();
  const uploadKeys = new Set<string>();

  test.beforeAll(async () => {
    if (SKIP_OWNER_UI) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_OWNER_UI) return;
    // `cleanup` deletes only each version's index.html; a set's other files go here.
    for (const id of scope.siteIds) await r2Store().deleteMany(await siteObjectKeys(db, id));
    await r2Store().deleteMany([...uploadKeys]);
    const buckets = scope.userIds.map((id) => `uploads:${id}`);
    if (buckets.length > 0) await db.delete(schema.rateLimits).where(inArray(schema.rateLimits.bucket, buckets));
    await cleanup(scope);
    await closeDb();
  });

  const same = (baseURL: string) => ({ origin: new URL(baseURL).origin });

  async function requestUpload(ctx: APIRequestContext, baseURL: string, userId: string, size: number) {
    const response = await ctx.post(`${baseURL}/api/uploads`, { headers: same(baseURL), data: { size_bytes: size } });
    expect(response.status(), "POST /api/uploads").toBe(200);
    const upload = uploadResponseSchema.parse(await response.json());
    uploadKeys.add(uploadObjectKey(userId, upload.upload_id));
    return upload;
  }

  test("AC33: 401 signed out; free past siteBytes × 1.1 is site_too_large; premium gets a URL that takes exactly size_bytes", async ({
    page,
    baseURL,
  }) => {
    const anonymous = await jarlessContext();
    try {
      const response = await anonymous.post(`${baseURL}/api/uploads`, {
        headers: same(baseURL!),
        data: { size_bytes: 1024 },
      });
      expect(response.status()).toBe(401);
    } finally {
      await anonymous.dispose();
    }

    const { userId } = await signInAs(page, baseURL!, scope);
    const tooLarge = await page.request.post(`${baseURL}/api/uploads`, {
      headers: same(baseURL!),
      data: { size_bytes: uploadMaxBytes("free") + 1 },
    });
    expect(tooLarge.status()).toBe(413);
    expect(studioErrorSchema.parse(await tooLarge.json()).error.code).toBe("site_too_large");

    await db.update(schema.profiles).set({ plan: "premium" }).where(eq(schema.profiles.id, userId));
    // Past free's ceiling, inside premium's — a size only the presigned path can carry.
    const big = await requestUpload(page.request, baseURL!, userId, limitsFor("free").siteBytes * 2);
    expect(big.max_bytes).toBe(uploadMaxBytes("premium"));

    const upload = await requestUpload(page.request, baseURL!, userId, 2048);
    expect(await putTo(upload, new Uint8Array(2049)), "edge case 14: another length is refused").toBe(403);
    expect(await putTo(upload, new Uint8Array(2048)), "exactly size_bytes is accepted").toBe(200);
    expect(await r2Store().get(uploadObjectKey(userId, upload.upload_id))).not.toBeNull();
  });

  test("AC34 + AC1: publish and replace by upload_id consume the upload; all four inputs are one set; foreign, unknown and keyless IDs are one upload_not_found", async ({
    page,
    request,
    baseURL,
  }) => {
    const { userId } = await signInAs(page, baseURL!, scope);
    const zip = await zipOf(FILES);

    // AC34: publish with a valid upload_id creates the site and deletes the upload.
    const upload = await requestUpload(page.request, baseURL!, userId, zip.length);
    expect(await putTo(upload, zip)).toBe(200);
    const published = await page.request.post(`${baseURL}/api/sites`, {
      headers: same(baseURL!),
      data: { upload_id: upload.upload_id },
    });
    expect(published.status(), await published.text()).toBe(201);
    const { site } = ownedPublishResultSchema.parse(await published.json());
    scope.siteIds.push(site.id);
    scope.slugs.add(site.slug);
    expect(await r2Store().get(uploadObjectKey(userId, upload.upload_id)), "used once: deleted").toBeNull();

    // The stored objects are the fixture's bytes, one per path.
    const [row] = await db
      .select({ versionId: schema.sites.currentVersionId })
      .from(schema.sites)
      .where(eq(schema.sites.id, site.id));
    const stored = await versionFiles(db, row!.versionId!);
    expect(stored.map((file) => file.path)).toEqual(Object.keys(FILES).sort());
    for (const { path } of stored) {
      const body = await r2Store().getStream(siteObjectKey(site.id, row!.versionId!, path));
      expect(Buffer.from(await new Response(body).arrayBuffer()).equals(Buffer.from(FILES[path]!)), path).toBe(true);
    }

    // Reusing the ID, an ID never uploaded and another profile's real upload: one answer.
    const notFound = async (uploadId: string, path = "/api/sites") => {
      const response = await page.request.post(`${baseURL}${path}`, {
        headers: same(baseURL!),
        data: { upload_id: uploadId },
      });
      expect(response.status(), await response.text()).toBe(404);
      const body = studioErrorSchema.parse(await response.json());
      expect(body.error.code).toBe("upload_not_found");
      return response.text();
    };
    const foreignId = crypto.randomUUID();
    const foreignKey = uploadObjectKey(crypto.randomUUID(), foreignId);
    uploadKeys.add(foreignKey);
    await r2Store().put(foreignKey, new Uint8Array(zip), UPLOAD_CONTENT_TYPE);
    const bodies = new Set([
      await notFound(upload.upload_id),
      await notFound(crypto.randomUUID()),
      await notFound(foreignId),
    ]);
    expect(bodies.size, "reused, unknown and foreign read the same").toBe(1);
    expect(await r2Store().get(foreignKey), "someone else's upload is untouched").not.toBeNull();

    // AC1, through the routes: the same set as multipart files, a multipart
    // archive and a JSON file list is the SAME content hash — `200 duplicate`
    // naming this site, with nothing new written.
    const form = new FormData();
    for (const [path, content] of Object.entries(FILES)) form.append("files", new Blob([content]), path);
    const archive = new FormData();
    archive.append("archive", new Blob([new Uint8Array(zip)]), "site.zip");
    const json = {
      files: Object.entries(FILES).map(([path, content]) =>
        typeof content === "string"
          ? { path, content }
          : { path, content: Buffer.from(content).toString("base64"), encoding: "base64" as const },
      ),
    };
    for (const [label, data] of [
      ["multipart files", form],
      ["multipart archive", archive],
      ["JSON files[]", json],
    ] as const) {
      const response = await page.request.post(`${baseURL}/api/sites`, {
        headers: same(baseURL!),
        ...(data instanceof FormData ? { multipart: data } : { data }),
      });
      expect(response.status(), `${label}: ${await response.text()}`).toBe(200);
      const result = ownedPublishResultSchema.parse(await response.json());
      expect(result.duplicate, label).toBe(true);
      expect(result.site.id, label).toBe(site.id);
    }
    const versions = await db
      .select({ id: schema.siteVersions.id })
      .from(schema.siteVersions)
      .where(eq(schema.siteVersions.siteId, site.id));
    expect(versions, "the duplicates wrote no version").toHaveLength(1);

    // AC34, replace: the same consume-once.
    const next = await zipOf({ ...FILES, "index.html": `${INDEX}<p>replaced</p>` });
    const second = await requestUpload(page.request, baseURL!, userId, next.length);
    expect(await putTo(second, next)).toBe(200);
    const replaced = await page.request.post(`${baseURL}/api/sites/${site.id}/replace`, {
      headers: same(baseURL!),
      data: { upload_id: second.upload_id },
    });
    expect(replaced.status(), await replaced.text()).toBe(200);
    expect(replaceResultSchema.parse(await replaced.json()).unchanged).toBe(false);
    expect(await r2Store().get(uploadObjectKey(userId, second.upload_id)), "used once: deleted").toBeNull();
    await notFound(second.upload_id, `/api/sites/${site.id}/replace`);

    // The keyless routes never read an upload — not even a live one of a real
    // account: `POST /api/publish` and the bearer replace alike.
    const third = await requestUpload(page.request, baseURL!, userId, zip.length);
    expect(await putTo(third, zip)).toBe(200);
    const keylessNotFound = async (response: APIResponse) => {
      expect(response.status(), await response.text()).toBe(404);
      expect(publishErrorSchema.parse(await response.json()).error).toBe("upload_not_found");
    };
    await keylessNotFound(await request.post("/api/publish", { data: { upload_id: third.upload_id } }));
    const draft = await publishViaApi(request, pageHtml(`e08-009-anon-${crypto.randomUUID().slice(0, 8)}`));
    expect(draft.status(), await draft.text()).toBe(201);
    const { slug, anonToken } = (await draft.json()) as { slug: string; anonToken: string };
    const [anonRow] = await db.select({ id: schema.sites.id }).from(schema.sites).where(eq(schema.sites.slug, slug));
    scope.siteIds.push(anonRow!.id);
    scope.slugs.add(slug);
    await keylessNotFound(
      await request.post(`/api/anon/${anonToken}/replace`, { data: { upload_id: third.upload_id } }),
    );
    expect(await r2Store().get(uploadObjectKey(userId, third.upload_id)), "still the owner's").not.toBeNull();
  });
});
