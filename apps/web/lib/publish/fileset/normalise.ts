/**
 * D7 — normalising a set, in the PRD's order:
 *
 *   1. drop OS junk (`__MACOSX/`, `.DS_Store`, `Thumbs.db`, `desktop.ini`);
 *   2. drop dotfiles, keeping `.well-known/`;
 *   3. strip one shared top folder, only when there is no root `index.html`
 *      (the `dist/` case; edge cases 1 and 2);
 *   4. a set whose only HTML file sits at the root → that file is `index.html`;
 *   5. require a root `index.html` → else `missing_index` (edge case 4).
 *
 * Every path is checked against `validateSitePath` (NFC, ≤ 512 B, ≤ 16
 * segments, no `..`/control/backslash, `_kept/` reserved) and against every
 * other path ignoring case, before the strip so a malformed path can never be
 * "repaired" by it. Pure: no store, no zod.
 */
import { SITE_404, SITE_INDEX, SITE_JUNK_NAMES, validateSitePath } from "@kept/shared";

import { fail, type PublishFailure } from "../pipeline";
import { invalidPath, missingIndex } from "./copy";
import { isHtml } from "./checks";
import type { RawFile } from "./types";

/** Folders whose whole contents are junk (`__MACOSX/`), matched as the first segment. */
const JUNK_FOLDERS: readonly string[] = SITE_JUNK_NAMES.filter((name) => name.endsWith("/")).map(
  (name) => name.slice(0, -1),
);

/** File names that are junk at any depth. */
const JUNK_FILES: readonly string[] = SITE_JUNK_NAMES.filter((name) => !name.endsWith("/"));

/** The one dot-folder a site may ship (RFC 8615). */
const WELL_KNOWN = ".well-known";

/**
 * Steps 1–2: whether D7 drops this path. A dot-segment (`.`/`..`) is not a
 * dotfile — it is an invalid path, and must reach `validateSitePath`. The zip
 * reader asks this too, so it never inflates a file that would be dropped.
 */
export function isIgnored(path: string): boolean {
  const segments = path.split("/");
  if (JUNK_FOLDERS.includes(segments[0]!)) return true;
  if (JUNK_FILES.includes(segments.at(-1)!)) return true;
  return segments.some(
    (segment) =>
      segment.startsWith(".") && segment !== "." && segment !== ".." && segment !== WELL_KNOWN,
  );
}

export interface Normalised {
  files: RawFile[];
  /** Dropped paths, in input order. */
  ignored: string[];
  has404: boolean;
}

export function normalise(input: readonly RawFile[]): Normalised | PublishFailure {
  const ignored: string[] = [];
  const kept: RawFile[] = [];
  for (const file of input) {
    if (isIgnored(file.path)) ignored.push(file.path);
    else kept.push(file);
  }

  let files = validated(kept);
  if (!Array.isArray(files)) return files;

  if (!files.some((file) => file.path === SITE_INDEX)) {
    const top = sharedTopFolder(files);
    if (top !== null) {
      // Re-validated: the strip can lift `dist/_kept/x` into the reserved `_kept/`.
      files = validated(files.map((file) => ({ ...file, path: file.path.slice(top.length + 1) })));
      if (!Array.isArray(files)) return files;
    }
  }

  const html = files.filter((file) => isHtml(file.path));
  if (!files.some((file) => file.path === SITE_INDEX) && html.length === 1 && !html[0]!.path.includes("/")) {
    files = files.map((file) => (file === html[0] ? { ...file, path: SITE_INDEX } : file));
  }

  if (!files.some((file) => file.path === SITE_INDEX)) {
    return fail(400, { error: "missing_index", message: missingIndex() });
  }
  return { files, ignored, has404: files.some((file) => file.path === SITE_404) };
}

/**
 * Each path through `validateSitePath` (stored NFC), then no two equal ignoring
 * case. The first offender — in input order — is named.
 */
function validated(files: readonly RawFile[]): RawFile[] | PublishFailure {
  const seen = new Set<string>();
  const out: RawFile[] = [];
  for (const file of files) {
    const result = validateSitePath(file.path);
    if (!result.ok) {
      return fail(400, { error: "invalid_path", message: invalidPath(file.path) });
    }
    const folded = result.path.toLowerCase();
    if (seen.has(folded)) {
      return fail(400, { error: "invalid_path", message: invalidPath(result.path) });
    }
    seen.add(folded);
    out.push({ ...file, path: result.path });
  }
  return out;
}

/** The folder every path sits inside, when there is exactly one; else `null`. */
function sharedTopFolder(files: readonly RawFile[]): string | null {
  const tops = new Set<string>();
  for (const { path } of files) {
    const slash = path.indexOf("/");
    if (slash === -1) return null;
    tops.add(path.slice(0, slash));
  }
  return tops.size === 1 ? [...tops][0]! : null;
}
