/**
 * Presigned uploads (E08 D5, task 009) — `createUpload`, `consumeUpload` and
 * the `POST /api/uploads` mapping in `requestOwnedUpload`.
 *
 * NO MOCKS: real dev R2 (the presigned PUT is sent from Node, which needs no
 * bucket CORS rule) and the real dev Neon `rate_limits` table. No KV is
 * touched. Every uploader is a scratch id (`e08-test-{uuid}`) nobody has, so
 * its limiter bucket and its `uploads/` prefix are this file's alone; both are
 * deleted in `after`.
 *
 * Never prints an upload URL — it is a bearer credential until it expires.
 * SKIPS without R2 credentials or `DATABASE_URL` (CI on fork PRs).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { limitsFor, RATE_LIMITS, UPLOAD_CONTENT_TYPE, uploadResponseSchema, studioErrorSchema } from "@kept/shared";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const REQUIRED = ["DATABASE_URL", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_AUTO"] as const;
const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
const skip: string | false =
  missing.length > 0 ? `credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local` : false;

const uploaders = new Set<string>();
const keys = new Set<string>();

function scratchUploader(): string {
  const id = `e08-test-${crypto.randomUUID()}`;
  uploaders.add(id);
  return id;
}

after(async () => {
  if (skip) return;
  const { db, closeDb } = await import("../db");
  const { rateLimits } = await import("../db/schema");
  const { inArray } = await import("drizzle-orm");
  const { r2Store } = await import("../storage/r2");
  if (keys.size > 0) await r2Store().deleteMany([...keys]);
  if (uploaders.size > 0) {
    await db.delete(rateLimits).where(inArray(rateLimits.bucket, [...uploaders].map((id) => `uploads:${id}`)));
  }
  await closeDb();
});

/** PUT `size` bytes to `url` with the signed type. Returns the status only. */
async function put(url: string, size: number, contentType = UPLOAD_CONTENT_TYPE): Promise<number> {
  const res = await fetch(url, { method: "PUT", headers: { "content-type": contentType }, body: new Uint8Array(size) });
  await res.body?.cancel();
  return res.status;
}

test("uploadMaxBytes is the plan's siteBytes × 1.1, rounded down; the key is the uploader's own prefix", async () => {
  const { UPLOAD_ZIP_OVERHEAD, uploadMaxBytes, uploadObjectKey } = await import("./upload");
  for (const plan of ["free", "premium"] as const) {
    assert.equal(uploadMaxBytes(plan), Math.floor(limitsFor(plan).siteBytes * UPLOAD_ZIP_OVERHEAD), plan);
  }
  assert.equal(uploadObjectKey("p1", "u1"), "uploads/p1/u1.zip");
});

test("AC33: premium gets a 15-minute URL on R2's own origin; exactly size_bytes is accepted, any other length or type refused", { skip }, async () => {
  const { createUpload, uploadMaxBytes, uploadObjectKey, UPLOAD_URL_TTL_SECONDS } = await import("./upload");
  const { r2Config } = await import("../storage/env");
  const { r2Store } = await import("../storage/r2");
  const uploader = scratchUploader();
  const size = 4096;

  const before = Date.now();
  const upload = uploadResponseSchema.parse(await createUpload(uploader, "premium", size));
  const key = uploadObjectKey(uploader, upload.upload_id);
  keys.add(key);

  assert.equal(upload.max_bytes, uploadMaxBytes("premium"));
  const expires = Date.parse(upload.expires_at);
  assert.ok(expires >= before + UPLOAD_URL_TTL_SECONDS * 1000 - 1000 && expires <= Date.now() + UPLOAD_URL_TTL_SECONDS * 1000);

  const url = new URL(upload.upload_url);
  const { accountId, bucket } = r2Config();
  assert.equal(url.origin, `https://${accountId}.r2.cloudflarestorage.com`, "the origin is configuration, never a request");
  assert.equal(url.pathname, `/${bucket}/${key}`, "the object is the uploader's own key");
  assert.equal(url.searchParams.get("X-Amz-Expires"), String(UPLOAD_URL_TTL_SECONDS));
  assert.deepEqual(url.searchParams.get("X-Amz-SignedHeaders")?.split(";"), ["content-length", "content-type", "host"]);

  assert.equal(await put(upload.upload_url, size + 1), 403, "edge case 14: a longer body is refused");
  assert.equal(await put(upload.upload_url, size - 1), 403, "a shorter body is refused");
  assert.equal(await put(upload.upload_url, size, "text/html"), 403, "another content type is refused");
  assert.equal(await r2Store().get(key), null, "no refused PUT stored anything");

  assert.equal(await put(upload.upload_url, size), 200, "exactly size_bytes is accepted");
  const stored = await r2Store().getStream(key);
  assert.ok(stored, "the object exists");
  assert.equal((await new Response(stored).arrayBuffer()).byteLength, size);
});

test("AC34 (expired): a URL past its expiry is refused, so the ID never names an object", { skip }, async () => {
  const { uploadObjectKey } = await import("./upload");
  const { r2Store } = await import("../storage/r2");
  const key = uploadObjectKey(scratchUploader(), crypto.randomUUID());
  keys.add(key);
  const url = await r2Store().presignPut(key, 16, UPLOAD_CONTENT_TYPE, 1);
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  assert.equal(await put(url, 16), 403);
  assert.equal(await r2Store().get(key), null);
});

test("AC33: free is refused past siteBytes × 1.1 with site_too_large — spending no quota — and served up to it", { skip }, async () => {
  const { createUpload, uploadMaxBytes } = await import("./upload");
  const { StudioRefusal } = await import("../sites/studio-refusal");
  const { peek } = await import("../rate-limit");
  const uploader = scratchUploader();
  const max = uploadMaxBytes("free");

  await assert.rejects(createUpload(uploader, "free", max + 1), (err: unknown) => {
    assert.ok(err instanceof StudioRefusal);
    assert.equal(err.code, "site_too_large");
    assert.match(err.message, /Free sites can be up to/);
    return true;
  });
  assert.deepEqual(
    await peek(`uploads:${uploader}`, { limit: 1, windowSeconds: RATE_LIMITS.uploadsPerUser.windowSeconds }),
    { allowed: true },
    "a refused size counts no hit",
  );
  // Q-new-2: signed-in free callers use this path between the 10 MB inline cap and their 20 MB.
  assert.equal((await createUpload(uploader, "free", max)).max_bytes, max);
});

test("Q-new-7: the 21st upload in an hour is rate_limited, keyed by profile id", { skip }, async () => {
  const { createUpload } = await import("./upload");
  const { StudioRefusal } = await import("../sites/studio-refusal");
  const uploader = scratchUploader();
  const other = scratchUploader();

  for (let i = 0; i < RATE_LIMITS.uploadsPerUser.limit; i += 1) {
    await createUpload(uploader, "premium", 1024);
  }
  await assert.rejects(createUpload(uploader, "premium", 1024), (err: unknown) => {
    assert.ok(err instanceof StudioRefusal);
    assert.equal(err.code, "rate_limited");
    return true;
  });
  assert.ok(await createUpload(other, "premium", 1024), "another profile has its own bucket");
});

test("requestOwnedUpload: the studio envelope for a bad body, a too-large size and a granted URL", { skip }, async () => {
  const { requestOwnedUpload } = await import("../sites/owner-routes");
  const uploader = scratchUploader();

  for (const raw of [null, {}, { size_bytes: 0 }, { size_bytes: 1.5 }, { size_bytes: "10" }]) {
    const outcome = await requestOwnedUpload(raw, uploader, "premium");
    assert.equal(outcome.ok, false, JSON.stringify(raw));
    assert.equal(outcome.status, 400);
    assert.equal(studioErrorSchema.parse(outcome.body).error.code, "invalid_request");
  }

  const tooLarge = await requestOwnedUpload({ size_bytes: limitsFor("premium").siteBytes * 2 }, uploader, "premium");
  assert.equal(tooLarge.status, 413);
  assert.equal(studioErrorSchema.parse(tooLarge.body).error.code, "site_too_large");

  const granted = await requestOwnedUpload({ size_bytes: 2048 }, uploader, "premium");
  assert.equal(granted.status, 200);
  uploadResponseSchema.parse(granted.body);
});

test("consume-once: consumeUpload deletes the object, and a second read of the ID is upload_not_found", { skip }, async () => {
  const { consumeUpload, createUpload, uploadObjectKey } = await import("./upload");
  const { readFileSet } = await import("../publish/fileset/read");
  const { downloadZip } = await import("client-zip");
  const uploader = scratchUploader();

  const zip = new Uint8Array(
    await downloadZip([{ name: "index.html", input: "<!doctype html><h1>once</h1>", lastModified: new Date(0) }]).arrayBuffer(),
  );
  const upload = await createUpload(uploader, "free", zip.length);
  const key = uploadObjectKey(uploader, upload.upload_id);
  keys.add(key);
  const res = await fetch(upload.upload_url, { method: "PUT", headers: { "content-type": UPLOAD_CONTENT_TYPE }, body: zip });
  await res.body?.cancel();
  assert.equal(res.status, 200);

  const request = () =>
    new Request("https://app.kept.test/api/sites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ upload_id: upload.upload_id }),
    });
  const set = await readFileSet(request(), { plan: "free", uploaderId: uploader });
  assert.ok(!("ok" in set), "the upload reads as a set");
  assert.equal(set.uploadKey, key);

  await consumeUpload(key);
  const again = await readFileSet(request(), { plan: "free", uploaderId: uploader });
  assert.ok("ok" in again && again.ok === false);
  assert.equal(again.body.error, "upload_not_found");

  await consumeUpload(key); // an already-deleted upload is not an error
});

// ── Kept upload URLs (MCP `create_upload`): the token and the PUT's refusals ──
// Pure: a test secret, and every case here is refused before R2 is touched.

const TOKEN_SECRET = "upload-token-test-secret-0123456789abcdefghij";

function putRequest(body: Uint8Array<ArrayBuffer> | null, headers: Record<string, string> = {}): Request {
  return new Request("https://app.kept.test/api/uploads/x", { method: "PUT", headers, body });
}

test("upload token: round-trips its grant, bound to its upload ID, owner and secret", async () => {
  const { mintUploadToken, verifyUploadToken } = await import("./upload");
  const uploadId = crypto.randomUUID();
  const grant = { owner: "mcp-abc", maxBytes: 1024, exp: Math.floor(Date.now() / 1000) + 60 };
  const token = mintUploadToken(uploadId, grant, TOKEN_SECRET);

  assert.deepEqual(verifyUploadToken(uploadId, token, TOKEN_SECRET), grant);
  // Another upload's ID, another secret: the same token names nothing.
  assert.equal(verifyUploadToken(crypto.randomUUID(), token, TOKEN_SECRET), "invalid");
  assert.equal(verifyUploadToken(uploadId, token, `${TOKEN_SECRET}x`), "invalid");

  // A rewritten grant (another owner's prefix, a bigger ceiling) keeps the old MAC: refused.
  const [, mac] = token.split(".");
  for (const forged of [{ ...grant, owner: "someone-else" }, { ...grant, maxBytes: 10 ** 9 }]) {
    const payload = Buffer.from(JSON.stringify(forged)).toString("base64url");
    assert.equal(verifyUploadToken(uploadId, `${payload}.${mac}`, TOKEN_SECRET), "invalid", JSON.stringify(forged));
  }
  for (const junk of ["", "x", "a.b", `${token}.extra`, `${token.slice(0, -2)}AA`]) {
    assert.equal(verifyUploadToken(uploadId, junk, TOKEN_SECRET), "invalid", `junk ${junk.length}`);
  }
});

test("upload token: expired at its exp", async () => {
  const { mintUploadToken, verifyUploadToken } = await import("./upload");
  const uploadId = crypto.randomUUID();
  const exp = Math.floor(Date.now() / 1000) + 60;
  const token = mintUploadToken(uploadId, { owner: "p", maxBytes: 10, exp }, TOKEN_SECRET);
  assert.equal(typeof verifyUploadToken(uploadId, token, TOKEN_SECRET, exp * 1000 - 1), "object");
  assert.equal(verifyUploadToken(uploadId, token, TOKEN_SECRET, exp * 1000), "expired");
});

test("receiveUpload: missing or forged token 403, expired 404 upload_not_found, past the ceiling 413, empty 400", async () => {
  const { mintUploadToken, receiveUpload } = await import("./upload");
  const uploadId = crypto.randomUUID();
  const live = (maxBytes: number) =>
    mintUploadToken(uploadId, { owner: "p", maxBytes, exp: Math.floor(Date.now() / 1000) + 60 }, TOKEN_SECRET);
  const refusal = async (outcome: Awaited<ReturnType<typeof receiveUpload>>) => {
    assert.equal(outcome.ok, false);
    return outcome.ok ? null : { status: outcome.status, error: outcome.body.error };
  };

  assert.deepEqual(await refusal(await receiveUpload(uploadId, null, putRequest(new Uint8Array(4)), TOKEN_SECRET)), {
    status: 403,
    error: "invalid_request",
  });
  assert.deepEqual(
    await refusal(await receiveUpload(crypto.randomUUID(), live(10), putRequest(new Uint8Array(4)), TOKEN_SECRET)),
    { status: 403, error: "invalid_request" },
    "a token for another upload",
  );
  assert.deepEqual(
    await refusal(await receiveUpload("not-a-uuid", live(10), putRequest(new Uint8Array(4)), TOKEN_SECRET)),
    { status: 403, error: "invalid_request" },
  );

  const expired = mintUploadToken(uploadId, { owner: "p", maxBytes: 10, exp: Math.floor(Date.now() / 1000) - 1 }, TOKEN_SECRET);
  assert.deepEqual(await refusal(await receiveUpload(uploadId, expired, putRequest(new Uint8Array(4)), TOKEN_SECRET)), {
    status: 404,
    error: "upload_not_found",
  });

  // Past the grant's ceiling: by the declared length, and by counting a body that declares none.
  assert.deepEqual(
    await refusal(await receiveUpload(uploadId, live(8), putRequest(new Uint8Array(9), { "content-length": "9" }), TOKEN_SECRET)),
    { status: 413, error: "site_too_large" },
  );
  const chunked = new Request("https://app.kept.test/api/uploads/x", {
    method: "PUT",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
        controller.enqueue(new Uint8Array(5));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
  assert.deepEqual(await refusal(await receiveUpload(uploadId, live(8), chunked, TOKEN_SECRET)), {
    status: 413,
    error: "site_too_large",
  });

  assert.deepEqual(await refusal(await receiveUpload(uploadId, live(8), putRequest(null), TOKEN_SECRET)), {
    status: 400,
    error: "invalid_request",
  });
});
