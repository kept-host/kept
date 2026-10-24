/**
 * Caps (D2), types (D8) and leading bytes (D9) — steps 3 and 4 of PRD §5.3,
 * over a set D7 has already normalised. Pure: no store, no zod.
 */
import {
  EXECUTABLE_SIGNATURES,
  IMAGE_SIGNATURES,
  MAX_PAGE_BYTES,
  SITE_FILE_TYPES,
  limitsFor,
  startsWithSignature,
  type Plan,
  type SiteFileType,
} from "@kept/shared";

import { fail, type PublishFailure } from "../pipeline";
import {
  executableFile,
  fileTooLarge,
  fileTypeNotAllowed,
  invalidFile,
  siteTooLarge,
  tooManyFiles,
} from "./copy";
import type { RawFile } from "./types";

/** A file that passed the checks, with the `Content-Type` its extension maps to. */
export interface TypedFile extends RawFile {
  contentType: string;
}

/** A path's extension, lowercase, without the dot; `""` for none (or a bare dotfile name). */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * D8's lookup. `Object.hasOwn`, because the extension is a stranger's string
 * and `SITE_FILE_TYPES["constructor"]` is not `undefined`.
 */
export function siteFileType(ext: string): SiteFileType | undefined {
  return Object.hasOwn(SITE_FILE_TYPES, ext)
    ? SITE_FILE_TYPES[ext as keyof typeof SITE_FILE_TYPES]
    : undefined;
}

export function isHtml(path: string): boolean {
  const ext = extensionOf(path);
  return ext === "html" || ext === "htm";
}

/**
 * Count, then total, then each file's own size (HTML ≤ `MAX_PAGE_BYTES` on
 * every plan → `page_too_large`; anything else ≤ `fileBytes`), then each file's
 * type, then its leading bytes. The first failure wins, naming its path.
 */
export function checkSet(files: readonly RawFile[], plan: Plan): TypedFile[] | PublishFailure {
  const { siteFiles, siteBytes, fileBytes } = limitsFor(plan);

  if (files.length > siteFiles) {
    return fail(413, { error: "too_many_files", message: tooManyFiles(files.length, plan, siteFiles) });
  }
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (total > siteBytes) {
    return fail(413, { error: "site_too_large", message: siteTooLarge(total, plan, siteBytes) });
  }

  for (const { path, bytes } of files) {
    const html = isHtml(path);
    const max = html ? MAX_PAGE_BYTES : fileBytes;
    if (bytes.length > max) {
      return fail(413, {
        error: html ? "page_too_large" : "file_too_large",
        message: fileTooLarge(path, bytes.length, max),
      });
    }
  }

  const typed: TypedFile[] = [];
  for (const file of files) {
    const ext = extensionOf(file.path);
    const type = siteFileType(ext);
    if (type === undefined) {
      return fail(400, { error: "file_type_not_allowed", message: fileTypeNotAllowed(ext, file.path) });
    }
    const refusal = leadingBytesRefusal(file, ext, type);
    if (refusal) return refusal;
    typed.push({ ...file, contentType: type.contentType });
  }
  return typed;
}

/**
 * D9. An image type must start with one of its own signatures, else
 * `invalid_file` — so a PE renamed `.png` is an invalid PNG. Any other non-text
 * type must not start with an executable's → `file_type_not_allowed`. Text
 * types are exempt: a `.js` file legitimately starts with `#!`.
 */
function leadingBytesRefusal(file: RawFile, ext: string, type: SiteFileType): PublishFailure | null {
  if (type.text) return null;
  if (type.magic !== undefined) {
    const valid = IMAGE_SIGNATURES[type.magic].some((sig) => startsWithSignature(file.bytes, sig));
    return valid
      ? null
      : fail(400, { error: "invalid_file", message: invalidFile(file.path, ext.toUpperCase()) });
  }
  return EXECUTABLE_SIGNATURES.some((sig) => startsWithSignature(file.bytes, sig))
    ? fail(400, { error: "file_type_not_allowed", message: executableFile(file.path) })
    : null;
}
