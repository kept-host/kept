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
 * Anonymous and keyless callers never get a URL: anyone could otherwise park
 * a site's worth of junk in R2 per request at kept's cost.
 */
import { limitsFor, RATE_LIMITS, UPLOAD_CONTENT_TYPE, type Plan, type UploadResponse } from "@kept/shared";

import { siteTooLarge } from "../publish/fileset/copy";
import { hit } from "../rate-limit";
import { StudioRefusal } from "../sites/studio-refusal";
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
export function uploadObjectKey(profileId: string, uploadId: string): string {
  return `uploads/${profileId}/${uploadId}.zip`;
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

  const limited = await hit(`uploads:${profileId}`, RATE_LIMITS.uploadsPerUser);
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

