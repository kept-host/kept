/**
 * What was dropped or chosen → one upload (E08 PRD §5.7, D3) — the browser half
 * shared by the studio (task 010) and the landing / `/p` replace (task 011).
 *
 * Every drop surface turns its input into ONE `UploadIntent`:
 *
 *   · one HTML file      → `html`  — today's single-file path, unchanged on the
 *                                    wire (`checkPageFile`, then `{ html }`);
 *   · one `.zip`         → `zip`   — sent as it is, never re-packed;
 *   · anything else      → `files` — a folder (drag, or a `webkitdirectory`
 *                                    input) or a list of files, with each
 *                                    file's path relative to what was dropped.
 *
 * A `files` intent is packed by `packEntries` into one store-only zip, so every
 * multi-file upload is one request carrying one `archive` part. `client-zip`
 * never compresses (MIT, 2.5.1): the bytes are mostly already-compressed
 * assets, and deflating them in the browser would cost seconds to save little.
 *
 * Nothing here decides whether a set is acceptable — file count, per-file size,
 * types and paths are the server's (`lib/publish/fileset/`), which answers with
 * its own sentence. The studio's one size pre-flight is
 * `lib/sites/owner-upload.ts`'s, because it needs the caller's plan.
 *
 * ⚠️ BROWSER-ONLY. `DataTransfer`, `FileSystemEntry` and `File` — no `node:*`,
 * nothing that reaches a store. `packEntries` and `toIntent` also run under
 * `tsx` (Node has `File` and `Response`), which is how `pack.test.ts` reads
 * them back.
 */
import { downloadZip } from "client-zip";

import { INLINE_BODY_MAX_BYTES, type PublishError } from "@kept/shared";

import { checkPageFile } from "./client";
import { missingIndex } from "./fileset/copy";

/** One file of a set, at its path relative to the folder (or list) it came in. */
export interface PackEntry {
  path: string;
  file: File;
}

/** One upload, whatever arrived. `label` names it on the mint card. */
export type UploadIntent =
  | { kind: "html"; file: File; label: string }
  | { kind: "zip"; file: File; label: string }
  | { kind: "files"; entries: PackEntry[]; label: string };

/** What the pickers offer. `toIntent` is the actual rule. */
export const UPLOAD_ACCEPT = "text/html,.html,.htm,.zip,application/zip";

/**
 * The most a packed set may weigh and still go inline as one multipart
 * `archive` part: the server's `INLINE_BODY_MAX_BYTES` less room for the
 * multipart envelope (boundaries, part headers, the `spa` field), which is a
 * few hundred bytes. A larger zip takes the presigned path (signed in), or is
 * refused (anonymous).
 */
const MULTIPART_ENVELOPE_BYTES = 4 * 1024;

const ZIP_NAME = /\.zip$/i;

/** The name `archive` parts are sent under — `readFileSet` wants a `.zip` name. */
const ARCHIVE_NAME = "site.zip";

/**
 * The files of a drop, folders walked.
 *
 * ⚠️ CALL IT SYNCHRONOUSLY FROM THE `drop` HANDLER. A `DataTransferItemList` is
 * emptied the moment the handler returns, so every item's entry is taken
 * before the first `await`; the walk that follows reads entries, which outlive
 * the event. A browser without `webkitGetAsEntry` gets the flat file list.
 */
export function collectDrop(transfer: DataTransfer): Promise<PackEntry[]> {
  const roots: FileSystemEntry[] = [];
  const loose: File[] = [];
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== "file") continue;
    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    if (entry) roots.push(entry);
    else {
      const file = item.getAsFile();
      if (file) loose.push(file);
    }
  }
  if (roots.length === 0 && loose.length === 0) loose.push(...Array.from(transfer.files));

  return (async () => {
    const entries = loose.map((file) => ({ path: file.name, file }));
    for (const root of roots) entries.push(...(await walk(root)));
    return entries;
  })();
}

/** Every file under `entry`, at its path below the dropped item's parent. */
async function walk(entry: FileSystemEntry): Promise<PackEntry[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    return [{ path: entry.fullPath.replace(/^\//, ""), file }];
  }
  if (!entry.isDirectory) return [];

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const out: PackEntry[] = [];
  // `readEntries` answers in batches (100 in Chromium) until it answers `[]`.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) return out;
    for (const child of batch) out.push(...(await walk(child)));
  }
}

/**
 * The files a picker chose. From a `webkitdirectory` input each carries its
 * path below the chosen folder's parent (`dist/assets/app.js`); from a plain
 * multi-select, its name.
 */
export function collectInput(files: FileList | readonly File[]): PackEntry[] {
  return Array.from(files, (file) => ({ path: file.webkitRelativePath || file.name, file }));
}

/** `dist` when every path sits under one top folder; otherwise `{n} files`. */
function setLabel(entries: readonly PackEntry[]): string {
  const tops = new Set(entries.map(({ path }) => (path.includes("/") ? path.split("/")[0] : "")));
  const [top] = tops;
  return tops.size === 1 && top ? top : `${entries.length.toLocaleString("en-US")} files`;
}

/**
 * The upload these entries make, or the sentence that refuses them before any
 * request: an empty drop (`missing_index`'s sentence — there is no index.html
 * in nothing) or one file that is neither a page nor a `.zip` (AC7's sentence,
 * from `checkPageFile`).
 */
export function toIntent(entries: readonly PackEntry[]): UploadIntent | PublishError {
  if (entries.length === 0) return { error: "missing_index", message: missingIndex() };
  if (entries.length > 1) return { kind: "files", entries: [...entries], label: setLabel(entries) };

  const [{ file }] = entries as [PackEntry];
  if (ZIP_NAME.test(file.name)) return { kind: "zip", file, label: file.name };
  const refusal = checkPageFile(file);
  return refusal ?? { kind: "html", file, label: file.name };
}

/** Whether `toIntent` refused. */
export function isRefusal(intent: UploadIntent | PublishError): intent is PublishError {
  return "error" in intent;
}

/** The set's inflated size — what the plan's `siteBytes` is measured against. */
export function setBytes(entries: readonly PackEntry[]): number {
  return entries.reduce((sum, { file }) => sum + file.size, 0);
}

/**
 * One store-only zip of `entries`, each at its relative path. `onProgress` is
 * told how many files are in so far, as `client-zip` takes them — the
 * "Packing {n} files…" line.
 */
export async function packEntries(
  entries: readonly PackEntry[],
  onProgress?: (packed: number, total: number) => void,
): Promise<Blob> {
  async function* inputs() {
    let packed = 0;
    for (const { path, file } of entries) {
      yield { name: path, input: file, lastModified: file.lastModified };
      packed += 1;
      onProgress?.(packed, entries.length);
    }
  }
  return downloadZip(inputs()).blob();
}

/** Whether a zip of this size goes inline as one multipart request (Q-new-2). */
export function fitsInline(zipBytes: number): boolean {
  return zipBytes <= INLINE_BODY_MAX_BYTES - MULTIPART_ENVELOPE_BYTES;
}

/** The multipart body `readFileSet` reads as a zip: one `archive` part, and `spa`. */
export function archiveForm(zip: Blob, spa: boolean): FormData {
  const form = new FormData();
  form.append("archive", zip, ARCHIVE_NAME);
  if (spa) form.append("spa", "true");
  return form;
}
