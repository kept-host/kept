/**
 * The "How it was made" page (E10 D6, PRD §5.3): a static HTML document at
 * `sites/{siteId}/_kept/readme.html`, served by the Worker at `/_kept/readme`
 * with kept's own CSP while the manifest's `badge.readme` is true.
 *
 * ── WHEN IT EXISTS (Q6) ──────────────────────────────────────────────────────
 * Only a KEPT page has one. `refreshReadmePage` writes it when the kept page has
 * a README and deletes it when the README is empty; on a draft it does nothing
 * at all — the draft badge never links it and the Worker never serves it, so a
 * stale object behind a demoted page is harmless until the next keep refreshes
 * it, or the purge job deletes it with the site.
 *
 * ── WHO CALLS IT ─────────────────────────────────────────────────────────────
 * Every writer that can change what the page shows, AFTER its own commit and
 * BEFORE the `syncManifest` it already makes — that sync's purge covers
 * `/_kept/readme` (`lib/storage/manifest.ts`), so the edge drops the old copy
 * twice, as every purge does: the details save, every keep (`syncAfterCommit`),
 * an owned publish that lands kept, a replace (`storeReplacement`) and a
 * restore.
 *
 * NEVER THROWS. The caller has committed; a failed R2 write is logged and the
 * next refresh of the same page repairs it.
 */
import { BADGE_TOKENS } from "@kept/shared";

import { readReadmeSource, type ReadmeSource } from "../db/queries/readme";
import { apexUrl } from "../email/waitlist";
import { liveUrl } from "../publish/pipeline";
import { PAGE_CONTENT_TYPE, r2Store, readmeObjectKey } from "../storage/r2";
import { escapeHtml } from "../utils";

import { renderReadme } from "./render";

const T = BADGE_TOKENS;
const LINK_REL = "nofollow ugc noopener";

/** System stacks: `default-src 'none'` loads no font, so none is named that would need one. */
const BODY_FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
const MONO_FONT = 'ui-monospace,SFMono-Regular,Menlo,monospace';

const STYLE =
  `*{box-sizing:border-box}` +
  `body{margin:0;background:${T["--surface"]};color:${T["--text"]};font:16px/1.6 ${BODY_FONT}}` +
  `main{max-width:720px;margin:0 auto;padding:32px 16px 48px}` +
  `a{color:${T["--accent"]}}` +
  `h1{font-size:28px;line-height:1.2;margin:16px 0 8px}` +
  `h2{font-size:20px;margin:28px 0 8px}h3{font-size:17px;margin:24px 0 8px}` +
  `.m,.back,footer{color:${T["--text-secondary"]};font-size:14px}` +
  `.m{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0 0 24px}` +
  `.back{text-decoration:none}` +
  `pre,code{font-family:${MONO_FONT};font-size:14px}` +
  `pre{overflow-x:auto;padding:12px;border:1px solid ${T["--border"]};border-radius:${T["--r-md"]};white-space:pre-wrap}` +
  `blockquote{margin:0;padding-left:12px;border-left:3px solid ${T["--border"]};color:${T["--text-secondary"]}}` +
  `table{border-collapse:collapse}th,td{border:1px solid ${T["--border"]};padding:4px 8px}` +
  `hr{border:0;border-top:1px solid ${T["--border"]}}` +
  `article{overflow-wrap:anywhere}` +
  `footer{margin-top:40px;padding-top:16px;border-top:1px solid ${T["--border"]};display:flex;gap:16px}`;

/** The heading: "How {title ?? slug} was made". */
export function readmeTitle(source: Pick<ReadmeSource, "title" | "slug">): string {
  return `How ${source.title ?? source.slug} was made`;
}

/**
 * The whole document. Pure. Every stored value is escaped here; the README body
 * comes from `renderReadme`, which emits no raw HTML, image or script.
 *
 * Model and tool show only while "Made with" is on — the same switch the badge
 * obeys — and the prompt only while "Show the prompt" is.
 */
export function readmeDocument(source: ReadmeSource): string {
  const title = escapeHtml(readmeTitle(source));
  const page = liveUrl(source.slug);
  const meta: string[] = [];
  if (source.showMadeWith && source.model) meta.push(`<span>Made with ${escapeHtml(source.model)}</span>`);
  if (source.showMadeWith && source.tool) meta.push(`<span>Using ${escapeHtml(source.tool)}</span>`);
  if (source.sourceUrl) {
    meta.push(`<a href="${escapeHtml(source.sourceUrl)}" rel="${LINK_REL}">Source</a>`);
  }
  const prompt =
    source.showPrompt && source.prompt
      ? `<h2>Prompt</h2><pre>${escapeHtml(source.prompt)}</pre>`
      : "";
  const report = apexUrl(`/report?url=${encodeURIComponent(`${page}/`)}`);

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title><style>${STYLE}</style></head><body><main>` +
    `<a class="back" href="/">&larr; Back to the page</a>` +
    `<h1>${title}</h1>` +
    (meta.length > 0 ? `<p class="m">${meta.join("")}</p>` : "") +
    prompt +
    `<article>${renderReadme(source.readme ?? "")}</article>` +
    `<footer><a href="${escapeHtml(apexUrl("/"))}">Made with kept</a>` +
    `<a href="${escapeHtml(report)}">Report</a></footer>` +
    `</main></body></html>`
  );
}

/**
 * Bring `sites/{siteId}/_kept/readme.html` in line with the row: written for a
 * kept page with a README, deleted for a kept page without one, untouched on a
 * draft (Q6). Never throws — see the header.
 */
export async function refreshReadmePage(siteId: string): Promise<void> {
  try {
    const source = await readReadmeSource(siteId);
    if (!source || source.expiresAt !== null) return;
    const key = readmeObjectKey(siteId);
    if (source.readme?.trim()) {
      await r2Store().put(key, readmeDocument(source), PAGE_CONTENT_TYPE);
    } else {
      await r2Store().delete(key);
    }
  } catch (err) {
    console.error(
      `[kept] README page refresh failed for site ${siteId} — ${err instanceof Error ? err.message : String(err)}. The next refresh of this page rewrites it.`,
    );
  }
}
