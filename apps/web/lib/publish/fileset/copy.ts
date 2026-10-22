/**
 * The file-set sentences (E08 PRD §8), as pure builders.
 *
 * ⚠️ BROWSER-SAFE. The studio and the landing (tasks 010/011) import this for
 * their client-side pre-flight, so the browser and the server say the same
 * sentence about the same folder. No `node:*`, no yauzl, nothing that touches a
 * store — only `@kept/shared` and other pure modules.
 *
 * Every path or extension a sentence repeats goes through `printablePath`
 * first: it came from a stranger's zip or JSON, and an error message is the
 * easiest thing in a system to end up rendered or logged.
 */
import type { Plan } from "@kept/shared";

import { PLAN_LABEL } from "../../plans/plan-label";
import { formatBytes } from "../../sites/display";

/** PRD §5.1: a repeated path is at most this many UTF-8 bytes. */
const PRINTABLE_MAX_BYTES = 200;

/** How many skipped names "Skipped {n} files ({list})" spells out before "…". */
const SKIPPED_LISTED = 5;

/**
 * Anything that is not a visible character: controls (C0, DEL, C1), format
 * characters (bidi overrides, zero-width joiners), line/paragraph separators,
 * private-use, unassigned code points and lone surrogates.
 */
const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/gu;

const ELLIPSIS = "…";

/**
 * A path made safe to repeat: every non-printable character becomes `?`, and
 * the result is cut to ≤ 200 UTF-8 bytes on a code-point boundary, ending in
 * `…` when it was cut.
 */
export function printablePath(path: string): string {
  const printable = path.replace(NOT_PRINTABLE, "?");
  const encoder = new TextEncoder();
  if (encoder.encode(printable).length <= PRINTABLE_MAX_BYTES) return printable;
  const budget = PRINTABLE_MAX_BYTES - encoder.encode(ELLIPSIS).length;
  let out = "";
  let used = 0;
  for (const char of printable) {
    const size = encoder.encode(char).length;
    if (used + size > budget) break;
    out += char;
    used += size;
  }
  return out + ELLIPSIS;
}

/** `200` → `200`, `1000` → `1,000`. */
function count(n: number): string {
  return n.toLocaleString("en-US");
}

function files(n: number): string {
  return n === 1 ? "1 file" : `${count(n)} files`;
}

export function missingIndex(): string {
  return "There's no index.html at the top of this folder. kept opens index.html first — add one or move it up a level.";
}

export function tooManyFiles(n: number, plan: Plan, max: number): string {
  return `This site has ${count(n)} files. ${PLAN_LABEL[plan]} sites can have up to ${count(max)}.`;
}

export function siteTooLarge(bytes: number, plan: Plan, max: number): string {
  return `This site is ${formatBytes(bytes)}. ${PLAN_LABEL[plan]} sites can be up to ${formatBytes(max)}.`;
}

/**
 * Q-new-2: one inline request carries at most `INLINE_BODY_MAX_BYTES`. The
 * body's real size is unknown when it was counted as it streamed, so the
 * sentence states only the ceiling.
 */
export function inlineTooLarge(max: number): string {
  return `This upload is over ${formatBytes(max)}, the most one request can carry. Sign in to publish a larger site.`;
}

export function fileTooLarge(path: string, bytes: number, max: number): string {
  return `${printablePath(path)} is ${formatBytes(bytes)}. Files can be up to ${formatBytes(max)}.`;
}

/** `ext` without its dot, lowercase; `""` when the name has none. */
export function fileTypeNotAllowed(ext: string, path: string): string {
  const what = ext === "" ? "files without an extension" : `.${printablePath(ext)} files`;
  return `kept doesn't host ${what} (${printablePath(path)}). Remove it and try again.`;
}

/** D9: a non-text file whose bytes are a program, whatever its extension says. */
export function executableFile(path: string): string {
  return `${printablePath(path)} is a program, and kept doesn't host programs. Remove it and try again.`;
}

/** `type` is what the extension claims, e.g. `PNG`. */
export function invalidFile(path: string, type: string): string {
  return `${printablePath(path)} isn't a valid ${printablePath(type)} file.`;
}

export function invalidArchive(): string {
  return "That .zip couldn't be opened. Re-create it and try again.";
}

export function invalidPath(path: string): string {
  return `${printablePath(path)} has a name kept can't serve. Use letters, numbers, - _ . and /.`;
}

/** D5 / edge case 13: one sentence for unknown, foreign, expired and used — never says which. */
export function uploadNotFound(): string {
  return "That upload wasn't found. It may have expired or already been used — upload it again.";
}

/**
 * D5: an uploaded zip ran past the plan's upload ceiling as it was read back
 * (the plan changed after the URL was signed). Only the ceiling is known.
 */
export function uploadTooLarge(max: number): string {
  return `This upload is over ${formatBytes(max)}, the most your plan can upload.`;
}

/** "Published. Skipped {n} files ({list})." — the first few names, then `…`. */
export function skipped(n: number, list: readonly string[]): string {
  const named = list.slice(0, SKIPPED_LISTED).map(printablePath).join(", ");
  const more = list.length > SKIPPED_LISTED ? `, ${ELLIPSIS}` : "";
  return `Published. Skipped ${files(n)} (${named}${more}).`;
}
