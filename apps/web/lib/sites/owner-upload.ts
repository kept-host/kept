/**
 * A studio drop → the body a publish or replace sends (E08 PRD §5.7, D4, D5).
 *
 * One function for every studio surface — the publish sheet, the Pages home's
 * window drop, a card's replace and the Versions tab — so they cannot disagree
 * about which door a set takes:
 *
 *   1. Pre-flight (`checkUpload`, before any request): a set whose files add up
 *      past the plan's `siteBytes` is `site_too_large` with the §8 sentence —
 *      and, on Free, the locked row (E06 D15). Counts, per-file sizes, types and
 *      paths are the server's (`lib/publish/fileset/`) and are not repeated.
 *   2. One HTML file → `{ html }`, unchanged on the wire.
 *   3. A folder or a file list → one store-only zip (`packEntries`).
 *   4. A zip within `INLINE_BODY_MAX_BYTES` (10 MB, Q-new-2) → one multipart
 *      `archive` part. Past it, any signed-in plan takes the presigned path up
 *      to its own `siteBytes`: `POST /api/uploads`, a PUT straight to R2 with
 *      progress, then `{ upload_id }`. An expired URL (403) is replaced and the
 *      PUT retried ONCE (edge case 15).
 *
 * Browser-only (it packs `File`s and PUTs with `XMLHttpRequest`); never
 * throws. `upload_url` never leaves `uploadZip`.
 */
import { limitsFor, type Plan, type StudioError } from "@kept/shared";

import { FILE_UNREADABLE } from "../publish/client";
import { packing, siteTooLarge, uploading } from "../publish/fileset/copy";
import { fitsInline, packEntries, setBytes, type UploadIntent } from "../publish/pack";
import { COULD_NOT_SAVE, putUpload, requestUpload, type OwnedBody } from "./owner-client";

/** Where a set is on its way out: packing in the browser, or the presigned PUT. */
export type UploadProgress =
  | { phase: "packing"; files: number; fraction: number }
  | { phase: "uploading"; bytes: number; fraction: number };

/** The §8 line for `progress`: "Packing {n} files…" / "Uploading {size}…". */
export function progressNotice(progress: UploadProgress): string {
  return progress.phase === "packing" ? packing(progress.files) : uploading(progress.bytes);
}

/** A refusal to show, and whether it is the plan's size cap on Free (the locked row). */
export interface UploadRefusal {
  error: StudioError;
  locked: boolean;
}

/** `error` as a refusal on `plan` — any `site_too_large` on Free earns the locked row. */
export function uploadRefusal(error: StudioError, plan: Plan): UploadRefusal {
  return { error, locked: error.code === "site_too_large" && plan === "free" };
}

/**
 * The pre-flight: `site_too_large` for a set whose files add up past the plan's
 * `siteBytes`, else `null`. A single page and a dropped `.zip` pass — the page
 * was `checkPageFile`'s, and a zip's inflated size is the server's to count.
 */
export function checkUpload(intent: UploadIntent, plan: Plan): UploadRefusal | null {
  if (intent.kind !== "files") return null;
  const max = limitsFor(plan).siteBytes;
  const total = setBytes(intent.entries);
  return total > max
    ? uploadRefusal({ code: "site_too_large", message: siteTooLarge(total, plan, max) }, plan)
    : null;
}

export type PreparedBody = { ok: true; body: OwnedBody } | ({ ok: false } & UploadRefusal);

const UNREADABLE: StudioError = { code: "invalid_request", message: FILE_UNREADABLE };

/** `intent` as the body to send, with `spa`, after any packing and presigned PUT. */
export async function prepareOwnedBody(
  intent: UploadIntent,
  {
    plan,
    spa,
    onProgress,
    signal,
  }: {
    plan: Plan;
    spa: boolean;
    onProgress: (progress: UploadProgress) => void;
    signal?: AbortSignal;
  },
): Promise<PreparedBody> {
  const refused = checkUpload(intent, plan);
  if (refused) return { ok: false, ...refused };

  if (intent.kind === "html") {
    try {
      return { ok: true, body: { html: await intent.file.text(), spa } };
    } catch {
      return { ok: false, error: UNREADABLE, locked: false };
    }
  }

  let zip: Blob;
  if (intent.kind === "zip") zip = intent.file;
  else {
    const files = intent.entries.length;
    onProgress({ phase: "packing", files, fraction: 0 });
    try {
      zip = await packEntries(intent.entries, (packed) =>
        onProgress({ phase: "packing", files, fraction: packed / files }),
      );
    } catch {
      return { ok: false, error: UNREADABLE, locked: false };
    }
  }

  if (fitsInline(zip.size)) return { ok: true, body: { archive: zip, spa } };
  return uploadZip(zip, { plan, spa, onProgress, signal });
}

/** D5: mint a URL, PUT the zip, and on a 403 (expired) mint once more and retry. */
async function uploadZip(
  zip: Blob,
  {
    plan,
    spa,
    onProgress,
    signal,
  }: { plan: Plan; spa: boolean; onProgress: (progress: UploadProgress) => void; signal?: AbortSignal },
): Promise<PreparedBody> {
  const report = (sent: number) => onProgress({ phase: "uploading", bytes: zip.size, fraction: sent / zip.size });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const minted = await requestUpload(zip.size, signal);
    if (!minted.ok) return { ok: false, ...uploadRefusal(minted.error, plan) };
    report(0);
    const status = await putUpload(minted.upload.upload_url, zip, report, signal);
    if (status !== null && status >= 200 && status < 300) {
      return { ok: true, body: { upload_id: minted.upload.upload_id, spa } };
    }
    if (status !== 403) break;
  }
  return { ok: false, error: COULD_NOT_SAVE, locked: false };
}
