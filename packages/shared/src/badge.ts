// @kept/shared — the page badge (E10 D1–D4).
//
// The control plane builds a `BadgeData` from Postgres in `syncManifest` and
// writes it into the KV manifest; the Worker reads it and appends
// `renderBadge(...)`'s markup before `</body>` of every HTML response. Both
// halves import THIS module, so the manifest field and the markup cannot drift.
//
// ⚠️ PURE AND WORKER-SAFE: zod only, no Node or DOM APIs, no `apps/web`.
//
// The badge renders inside a stranger's page, where `globals.css` does not
// exist, so its few colours and radii are copied from the LIGHT tokens into
// `BADGE_TOKENS` (Q11). `apps/web/lib/badge/contract.test.ts` parses
// `globals.css` and fails when a value drifts. No other file holds a hex for it.

import { z } from "zod";

import { SLUG_MAX_LENGTH } from "./constants";
import { PROVENANCE_LIMITS } from "./provenance";

/** Standard shows every link; minimal (Pro) is a small mark that expands (PRD §5.1). */
export const BADGE_STYLES = ["standard", "minimal"] as const;
export type BadgeStyle = (typeof BADGE_STYLES)[number];

/** The badge follows the page: a draft says so, a kept page credits its maker. */
export const BADGE_VARIANTS = ["draft", "kept"] as const;
export type BadgeVariant = (typeof BADGE_VARIANTS)[number];

/** The largest markup `renderBadge` may produce, in UTF-8 bytes (PRD §4.2). */
export const BADGE_MAX_BYTES = 4096;

/**
 * Everything the badge shows (D3) — one object in the manifest, so a cold miss
 * stays one KV read and one R2 read. `syncManifest` sets a field only when the
 * badge shows it: `model` only if "Made with" is on, `remix` only if
 * `remixAllowed`, `readme` only while the page is kept and has one (Q6).
 * `refCode` is what goes in `?ref=` — the current handle when set, else the
 * permanent code (Q3). `handle` is shown expanded only (Q13).
 */
export const badgeDataSchema = z.object({
  variant: z.enum(BADGE_VARIANTS),
  style: z.enum(BADGE_STYLES),
  model: z.string().max(PROVENANCE_LIMITS.model).optional(),
  readme: z.literal(true).optional(),
  remix: z.literal(true).optional(),
  refCode: z.string().max(SLUG_MAX_LENGTH).optional(),
  handle: z.string().max(SLUG_MAX_LENGTH).optional(),
});

export type BadgeData = z.infer<typeof badgeDataSchema>;

/**
 * The light token values the badge paints with, keyed by their `globals.css`
 * name (Q11). Light-only: the badge sits on someone else's page, whose theme
 * kept cannot know.
 */
export const BADGE_TOKENS = {
  "--surface": "#ffffff",
  "--border": "#e5e0d8",
  "--text": "#1a1714",
  "--text-secondary": "#6b645c",
  "--accent": "#6d4aff",
  "--r-md": "12px",
  "--r-pill": "999px",
  "--shadow-md": "0 4px 16px rgba(40, 30, 20, 0.08)",
} as const;

/**
 * D8 (Q12): whether a page may be remixed. Only a kept page can be — a draft's
 * badge has no Remix link and `remix_of` must name a kept page. The owner's
 * explicit choice wins; `null` is the default rule: on when a model is set.
 */
export function remixAllowed(page: {
  allowRemix: boolean | null;
  kept: boolean;
  model: string | null | undefined;
}): boolean {
  if (!page.kept) return false;
  return page.allowRemix ?? Boolean(page.model);
}

/** Escape for HTML text and double- or single-quoted attribute values. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** FNV-1a, 32-bit, as 8 hex chars — synchronous, so the Worker's ETag needs no await. */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const T = BADGE_TOKENS;
const FONT = 'ui-monospace,"JetBrains Mono",SFMono-Regular,Menlo,monospace';

/** Every style lives in the shadow root; `all: initial` keeps page CSS out (D2). */
const SHADOW_STYLE =
  `:host{all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;` +
  `max-width:min(360px,90vw);font:12px/1.5 ${FONT};color:${T["--text"]}}` +
  `.b{display:flex;flex-wrap:wrap;align-items:center;gap:2px 10px;padding:4px 12px;` +
  `background:${T["--surface"]};border:1px solid ${T["--border"]};border-radius:${T["--r-md"]};` +
  `box-shadow:${T["--shadow-md"]}}` +
  `.p{border-radius:${T["--r-pill"]}}` +
  `a{color:inherit;text-decoration:none}a:hover,a:focus-visible{color:${T["--accent"]};text-decoration:underline}` +
  `.k{font-weight:600}.m{color:${T["--text-secondary"]}}` +
  `summary{list-style:none;cursor:pointer;width:max-content;margin-left:auto}` +
  `summary::-webkit-details-marker{display:none}details[open]>summary{margin-bottom:6px}`;

/** The light-DOM line a browser without declarative shadow DOM shows instead (D2). */
const FALLBACK_STYLE =
  `position:fixed;right:12px;bottom:12px;z-index:2147483647;font:12px ${FONT};` +
  `color:${T["--text"]};background:${T["--surface"]};border:1px solid ${T["--border"]};` +
  `border-radius:${T["--r-pill"]};padding:4px 12px`;

export interface BadgeContext {
  /** The landing origin, e.g. `https://kept.host` — from configuration, never the request. */
  apexOrigin: string;
  /** The page's own origin, e.g. `https://my-page.kept.host`. */
  pageOrigin: string;
  /** The page's slug — the Remix link's path. */
  slug: string;
}

export interface RenderedBadge {
  /** The full `<kept-badge>` element, appended before `</body>`. */
  html: string;
  /** 8 hex chars identifying `html` — the suffix of the edge's composite ETag (Risk 1). */
  badgeHash: string;
}

/**
 * The badge's markup (D2, PRD §5.1). Pure: the same data and context always give
 * the same bytes. Every interpolated value is escaped HERE, even though the
 * control plane sanitised it (D3).
 *
 * The draft variant links to the drafts explainer and the report page only —
 * never a claim URL, keep link, token or countdown (D4).
 */
export function renderBadge(data: BadgeData, ctx: BadgeContext): RenderedBadge {
  const apex = ctx.apexOrigin.replace(/\/+$/, "");
  const page = ctx.pageOrigin.replace(/\/+$/, "");
  const link = (href: string, text: string, cls?: string) =>
    `<a${cls ? ` class="${cls}"` : ""} href="${escapeHtml(href)}">${text}</a>`;
  const report = link(`${apex}/report?url=${encodeURIComponent(`${page}/`)}`, "Report", "m");

  let inner: string;
  let fallbackMain: string;
  if (data.variant === "draft") {
    fallbackMain = link(`${apex}/drafts`, "Draft · kept.host", "k");
    inner = `<div class="b p">${fallbackMain}${report}</div>`;
  } else {
    const mark = link(data.refCode ? `${apex}/?ref=${encodeURIComponent(data.refCode)}` : `${apex}/`, "kept", "k");
    fallbackMain = mark;
    const parts = [mark];
    if (data.handle) parts.push(`<span class="m">by @${escapeHtml(data.handle)}</span>`);
    if (data.model) parts.push(`<span>Made with ${escapeHtml(data.model)}</span>`);
    if (data.readme) parts.push(link(`${page}/_kept/readme`, "How it was made"));
    if (data.remix) parts.push(link(`${apex}/remix/${encodeURIComponent(ctx.slug)}`, "Remix"));
    parts.push(report);
    const full = `<div class="b">${parts.join("")}</div>`;
    inner =
      data.style === "minimal"
        ? `<details><summary class="b p k">kept</summary>${full}</details>`
        : full;
  }

  const html =
    `<kept-badge><template shadowrootmode="open"><style>${SHADOW_STYLE}</style>${inner}</template>` +
    `<span style="${escapeHtml(FALLBACK_STYLE)}">${fallbackMain} · ${report}</span></kept-badge>`;
  return { html, badgeHash: fnv1a(html) };
}
