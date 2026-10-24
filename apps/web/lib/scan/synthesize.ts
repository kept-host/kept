/**
 * D15: a whole file set → ONE synthetic HTML document for the unchanged
 * `extract()`, so a version costs one classifier call whatever its file count
 * and a phishing form in `login.html` is read like one in `index.html`.
 *
 * The order: root `index.html`, then every other `.html`/`.htm` by size
 * ascending, then `.js`/`.mjs`/`.cjs` by size ascending, each wrapped as a
 * `<script>` block (ties by path). Files are taken until their sizes reach
 * `SCAN_TEXT_BUDGET_CHARS` — the file that reaches it is the last one in, so a
 * 3 MB bundle still reaches `extract()`, whose own 1 MB / 2 s script caps then
 * record what they skip in `unparsedScriptBytes` (edge case 17). Every other
 * type — CSS, JSON, images, fonts, every non-text type — is never read or sent.
 *
 * `scanFiles` decides from sizes alone, so the scanner picks what to read from
 * `site_version_files` before any R2 read; `synthesize` applies the same choice
 * to the texts it was handed.
 *
 * PURE: no network, no database, no storage.
 */
import { SCAN_TEXT_BUDGET_CHARS, SITE_INDEX } from "@kept/shared";

import { extensionOf } from "../publish/fileset/checks";

/** A file of a set as the scan plans it: its path and byte length. */
export interface ScanFile {
  path: string;
  sizeBytes: number;
}

const HTML_EXTENSIONS: ReadonlySet<string> = new Set(["html", "htm"]);
const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(["js", "mjs", "cjs"]);

/** D15's group of a path — root index, other HTML, script — or `null`: never scanned. */
function group(path: string): number | null {
  if (path === SITE_INDEX) return 0;
  const ext = extensionOf(path);
  if (HTML_EXTENSIONS.has(ext)) return 1;
  if (SCRIPT_EXTENSIONS.has(ext)) return 2;
  return null;
}

/** The files a scan reads, in D15's order, cut where their sizes reach the budget. Empty files add nothing and are left out. */
export function scanFiles<T extends ScanFile>(files: readonly T[]): T[] {
  const ranked = files
    .filter((file) => file.sizeBytes > 0)
    .flatMap((file) => {
      const rank = group(file.path);
      return rank === null ? [] : [{ file, rank }];
    })
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.file.sizeBytes - b.file.sizeBytes ||
        (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0),
    );
  const chosen: T[] = [];
  let total = 0;
  for (const { file } of ranked) {
    if (total >= SCAN_TEXT_BUDGET_CHARS) break;
    chosen.push(file);
    total += file.sizeBytes;
  }
  return chosen;
}

/** A script body that cannot close its own `<script>` block early. */
function scriptBlock(text: string): string {
  return `<script>${text.replace(/<\/(script)/gi, "<\\/$1")}</script>`;
}

/**
 * The one document `extract()` reads for a set. Each file is preceded by a
 * comment naming its path (`>` percent-encoded, so no path can close the comment).
 * A set whose scan takes only its root `index.html` — every single-file page —
 * is that file's text exactly, so single-file extraction is unchanged.
 */
export function synthesize(files: readonly { path: string; text: string }[]): string {
  const chosen = scanFiles(files.map((file) => ({ ...file, sizeBytes: Buffer.byteLength(file.text, "utf8") })));
  if (chosen.length === 1 && chosen[0]!.path === SITE_INDEX) return chosen[0]!.text;
  return chosen
    .map(({ path, text }) => {
      const body = SCRIPT_EXTENSIONS.has(extensionOf(path)) ? scriptBlock(text) : text;
      return `<!-- ${path.replaceAll(">", "%3E")} -->\n${body}`;
    })
    .join("\n");
}
