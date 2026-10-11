/**
 * The legal texts (E06a, PRD §6 / D8) — server-only: reads `content/legal/`.
 *
 * `content/legal/{impressum,privacy}.md` are VERBATIM copies of the files
 * delivered with the PRD. Nothing here edits them; Arun fills the `[[…]]`
 * placeholders himself. While any remain, the pages carry a DRAFT banner and a
 * prod release fails (AC19, task 010's smoke).
 *
 * Rendered with `marked`. The content is trusted (repo files), but raw HTML is
 * still escaped rather than passed through: the files are Markdown, and an
 * inline tag in a later edit should show up as text, not become markup.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { Marked } from "marked";

import { escapeHtml } from "../utils";
import { LEGAL_DOCS, type LegalDoc } from "./links";

/** `[[` opens every placeholder the delivered texts use. */
const PLACEHOLDER_OPEN = "[[";

const markdown = new Marked({
  gfm: true,
  // The Impressum's address block is one line per field with no blank lines
  // between them; without `breaks` it would run together into one paragraph.
  breaks: true,
  renderer: {
    html: ({ text }) => escapeHtml(text),
  },
});

/** The raw Markdown of one legal file. `process.cwd()` is `apps/web` in `next build`, `next start` and the unit tests. */
export function legalSource(doc: LegalDoc): string {
  return readFileSync(
    path.join(process.cwd(), "content", "legal", `${doc}.md`),
    "utf8"
  );
}

export function hasLegalPlaceholders(source: string): boolean {
  return source.includes(PLACEHOLDER_OPEN);
}

/** True while either legal file still contains a `[[…]]` placeholder. */
export function legalPlaceholdersRemain(): boolean {
  return LEGAL_DOCS.some((doc) => hasLegalPlaceholders(legalSource(doc)));
}

/** The file's first `# ` heading — the page title. */
export function legalTitle(doc: LegalDoc): string {
  const heading = /^#\s+(.+)$/m.exec(legalSource(doc))?.[1];
  if (!heading) throw new Error(`content/legal/${doc}.md has no "# " heading`);
  return heading.trim();
}

export function renderLegal(doc: LegalDoc): string {
  return markdown.parse(legalSource(doc), { async: false });
}
