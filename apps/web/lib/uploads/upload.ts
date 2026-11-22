/**
 * Presigned zip uploads (E08 D5) — the large-site path for signed-in callers.
 *
 * `POST /api/uploads` mints a 15-minute SigV4 PUT URL with `content-length`
 * signed to the size the caller declared; the browser PUTs the zip straight to
 * R2; the caller then publishes or replaces with `{ upload_id }`, which
 * `readFileSet` reads back from here. Inline bodies stop at
 * `INLINE_BODY_MAX_BYTES` (10 MB, Q-new-2), so this is how any signed-in plan
 * reaches its own `siteBytes`.
 *
 * NO TABLE (Arun, 2026-10-22, Q-new-3). The binding IS the key:
 * `uploads/{profileId}/{uploadId}.zip`. A publish resolves an ID only under the
 * caller's own prefix, so someone else's ID, an expired one (never PUT before
 * the URL lapsed) and a used one (deleted after its publish) are all simply
 * absent — one `upload_not_found`, revealing nothing. Objects never consumed are
 * collected by the bucket's 1-day lifecycle rule on `uploads/` (a human step:
 * the R2 token cannot set or read lifecycle rules).
 *
 * Anonymous HTTP callers never get a URL: anyone could otherwise park a site's
 * worth of junk in R2 per request at kept's cost.
 *
 * MCP UPLOADS (`create_upload`) take a second route in: a kept URL,
 * `PUT /api/uploads/{uploadId}?t=<token>`, that any plain `curl -T` can hit —
 * no size up front, no signed headers to get exactly right, and kept's own
 * host for a sandbox to allow rather than R2's. The token is an HMAC over the
 * upload ID, the owner's prefix, the byte ceiling and the expiry, keyed off
 * `MCP_SESSION_SECRET` with its own label, so nothing is stored here either.
 * The owner is the key owner's profile id, or `mcp-{hash}` for a keyless MCP
 * session (`sessionUploader`) — the minting session is the only one that can
 * publish it. The body lands at the same `uploadObjectKey`, so `readFileSet`
 * reads it back exactly like a presigned one.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { limitsFor, RATE_LIMITS, UPLOAD_CONTENT_TYPE, type Plan, type UploadResponse } from "@kept/shared";
import { z } from "zod";

import { siteTooLarge, uploadNotFound, uploadTooLarge } from "../publish/fileset/copy";
import { readBounded } from "../publish/fileset/read";
import { UnreadableBodyError } from "../publish/http";
import { fail, type PublishFailure } from "../publish/pipeline";
import { hit, type RateLimitResult } from "../rate-limit";
import { StudioRefusal } from "../sites/studio-refusal";
import { appOrigin, mcpSessionSecret } from "../storage/env";
import { r2Store } from "../storage/r2";

/** Zip overhead over the inflated set: a URL is signed for up to `siteBytes × 1.1`. */
export const UPLOAD_ZIP_OVERHEAD = 1.1;

/** How long a presigned PUT URL stays valid (D5). */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** The largest zip `plan` may upload: `siteBytes × UPLOAD_ZIP_OVERHEAD`, rounded down. */
export function uploadMaxBytes(plan: Plan): number {
  return Math.floor(limitsFor(plan).siteBytes * UPLOAD_ZIP_OVERHEAD);
}

/** The one place the upload layout is spelled — keyed by the uploader (Q-new-3). */
export function uploadObjectKey(owner: string, uploadId: string): string {
  return `uploads/${owner}/${uploadId}.zip`;
}

/** Spend one of `owner`'s large uploads this hour (Q-new-7) — presigned or kept URL alike. */
export function spendUpload(owner: string): Promise<RateLimitResult> {
  return hit(`uploads:${owner}`, RATE_LIMITS.uploadsPerUser);
}

/**
 * A presigned PUT for a `sizeBytes` zip into `profileId`'s own prefix.
 *
 * The size is checked before the limiter, so a refused size spends none of the
 * hour's 20 (Q-new-7, keyed by profile id). Refusals are `StudioRefusal`s:
 * `site_too_large` (413) and `rate_limited` (429).
 */
export async function createUpload(
  profileId: string,
  plan: Plan,
  sizeBytes: number,
): Promise<UploadResponse> {
  const maxBytes = uploadMaxBytes(plan);
  if (sizeBytes > maxBytes) {
    throw new StudioRefusal("site_too_large", siteTooLarge(sizeBytes, plan, limitsFor(plan).siteBytes));
  }

  const limited = await spendUpload(profileId);
  if (!limited.allowed) {
    throw new StudioRefusal(
      "rate_limited",
      `That's a lot of large uploads in an hour. Try again in ${Math.ceil(limited.retryAfterSeconds / 60)} min.`,
    );
  }

  const uploadId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000);
  const uploadUrl = await r2Store().presignPut(
    uploadObjectKey(profileId, uploadId),
    sizeBytes,
    UPLOAD_CONTENT_TYPE,
    UPLOAD_URL_TTL_SECONDS,
  );
  return { upload_id: uploadId, upload_url: uploadUrl, expires_at: expiresAt.toISOString(), max_bytes: maxBytes };
}

// --- Kept upload URLs (MCP `create_upload`) -----------------------------------

/** What an upload token grants: the owner's prefix, the byte ceiling, the expiry in unix seconds. */
const grantSchema = z.object({ owner: z.string().min(1), maxBytes: z.number().int().positive(), exp: z.number().int() });

type UploadGrant = z.infer<typeof grantSchema>;

const UPLOAD_ID = z.string().uuid();

const INVALID_UPLOAD_URL = "This upload URL is not valid. PUT to the upload_url exactly as create_upload returned it.";

/** The token's MAC, keyed by a label-separated derivation of the MCP session secret: a session MAC is never an upload MAC. */
function grantMac(uploadId: string, payload: string, secret: string): Buffer {
  const key = createHmac("sha256", secret).update("kept upload token v1").digest();
  return createHmac("sha256", key).update(`${uploadId}.${payload}`).digest();
}

/** `base64url(JSON grant) + "." + base64url(MAC)` — bound to `uploadId`, which the URL path carries. */
export function mintUploadToken(uploadId: string, grant: UploadGrant, secret: string = mcpSessionSecret()): string {
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return `${payload}.${grantMac(uploadId, payload, secret).toString("base64url")}`;
}

/** The grant `token` carries for `uploadId`, `"invalid"` when its MAC does not verify, `"expired"` past its `exp`. */
export function verifyUploadToken(
  uploadId: string,
  token: string,
  secret: string = mcpSessionSecret(),
  now: number = Date.now(),
): UploadGrant | "invalid" | "expired" {
  const [payload, given, extra] = token.split(".");
  if (!payload || !given || extra !== undefined) return "invalid";
  const expected = grantMac(uploadId, payload, secret);
  const mac = Buffer.from(given, "base64url");
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return "invalid";
  let grant: UploadGrant;
  try {
    grant = grantSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return "invalid";
  }
  return grant.exp * 1000 <= now ? "expired" : grant;
}

/**
 * A kept upload URL into `owner`'s prefix, valid `UPLOAD_URL_TTL_SECONDS`, for a
 * zip of at most `uploadMaxBytes(plan)`. Spends nothing: the caller has already
 * spent the hour's upload (`spendUpload`). The URL is a bearer credential until
 * it expires — never log it.
 */
export function mintUploadLink(owner: string, plan: Plan, secret: string = mcpSessionSecret()): UploadResponse {
  const uploadId = crypto.randomUUID();
  const maxBytes = uploadMaxBytes(plan);
  const exp = Math.floor(Date.now() / 1000) + UPLOAD_URL_TTL_SECONDS;
  const token = mintUploadToken(uploadId, { owner, maxBytes, exp }, secret);
  return {
    upload_id: uploadId,
    upload_url: `${appOrigin()}/api/uploads/${uploadId}?t=${token}`,
    expires_at: new Date(exp * 1000).toISOString(),
    max_bytes: maxBytes,
  };
}

/** `PUT /api/uploads/{uploadId}`'s answer. */
export type ReceivedUpload = { ok: true; body: { upload_id: string; bytes: number } };

/**
 * Store the zip a kept upload URL was PUT with. Buffered, not streamed: R2's
 * S3 PUT needs a `Content-Length` (see `r2Store`), and `curl -T` from a pipe
 * may send none — so the body is counted into memory up to the grant's ceiling
 * and refused past it (413 `site_too_large`). A repeat PUT overwrites the same
 * object until the token expires. A missing or forged token is 403; one past
 * its expiry is `upload_not_found`, as an unknown ID is at publish.
 */
export async function receiveUpload(
  uploadId: string,
  token: string | null,
  request: Request,
  secret: string = mcpSessionSecret(),
): Promise<ReceivedUpload | PublishFailure> {
  const grant =
    token && UPLOAD_ID.safeParse(uploadId).success ? verifyUploadToken(uploadId, token, secret) : "invalid";
  if (grant === "invalid") {
    await request.body?.cancel();
    return fail(403, { error: "invalid_request", message: INVALID_UPLOAD_URL });
  }
  if (grant === "expired") {
    await request.body?.cancel();
    return fail(404, { error: "upload_not_found", message: uploadNotFound() });
  }

  let bytes: Uint8Array<ArrayBuffer> | null;
  try {
    bytes = await readBounded(request, grant.maxBytes);
  } catch (err) {
    if (err instanceof UnreadableBodyError) return fail(400, { error: "invalid_request", message: err.message });
    throw err;
  }
  if (bytes === null) return fail(413, { error: "site_too_large", message: uploadTooLarge(grant.maxBytes) });
  if (bytes.length === 0) {
    return fail(400, { error: "invalid_request", message: "The upload is empty. PUT the .zip file itself." });
  }

  await r2Store().put(uploadObjectKey(grant.owner, uploadId), bytes, UPLOAD_CONTENT_TYPE);
  return { ok: true, body: { upload_id: uploadId, bytes: bytes.length } };
}

/**
 * Used once: delete the upload a publish or replace just stored. A failed delete
 * is logged and swallowed — the publish already landed, and the lifecycle rule
 * collects the object within a day.
 */
export async function consumeUpload(key: string): Promise<void> {
  try {
    await r2Store().delete(key);
  } catch (err) {
    console.error(`[uploads] could not delete a used upload — ${err instanceof Error ? err.message : String(err)}`);
  }
}

