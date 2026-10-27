/**
 * Provenance (E09 D10) on the way IN: the optional "how this page was made"
 * fields a publish or replace carries (`provenanceShape`, `@kept/shared`) →
 * what the `sites` columns store.
 *
 * Pure. Every request has already been through zod (trimmed, capped, empty →
 * absent); this is the second pass that zod does not express — control
 * characters out, the caps re-applied after that, `source_url` normalised —
 * and it is safe on input that never met the schema (E09's MCP arguments).
 *
 * ⚠️ UNTRUSTED STRANGER-AUTHORED TEXT, stored as text. No HTML is parsed or
 * escaped here: E10 renders these fields and escapes them there. `title` is
 * the one exception, because it shares `sites.title` with the page's own
 * `<title>` and so goes through the same cleaning (`cleanTitle`).
 *
 * Absent stays ABSENT (`undefined`), never `null`: a replace writes only the
 * fields its request sent, and "not sent" must not read as "clear it".
 */
import { PROVENANCE_LIMITS, provenanceShape, slugSchema } from "@kept/shared";

import { cleanTitle } from "./page-title";

type ProvenanceField = keyof typeof provenanceShape;

/** The provenance fields as a request carries them, after `provenanceShape` or not. */
export type ProvenanceInput = { [K in ProvenanceField]?: string | undefined };

/** What the `sites` columns take. Every field optional: absent = not sent. */
export interface StoredProvenance {
  /** Stored with `title_source = 'owner'` (Q7). */
  title?: string;
  model?: string;
  tool?: string;
  prompt?: string;
  readme?: string;
  sourceUrl?: string;
  /** The remixed page's SLUG; resolved to its id in SQL only when it is kept and live (Q8). */
  remixOf?: string;
}

/** The request keys that carry provenance — `title`, `model`, … `remix_of`. */
export const PROVENANCE_FIELDS = Object.keys(provenanceShape) as ProvenanceField[];

/** Just the provenance keys of a parsed envelope (or a multipart form's fields). */
export function provenanceOf(fields: ProvenanceInput): ProvenanceInput {
  return Object.fromEntries(PROVENANCE_FIELDS.map((key) => [key, fields[key]]));
}

/** C0 controls and DEL, plus the C1 block. */
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;

/** The same, sparing `\n` and `\t` — for the two multi-line fields. */
const CONTROL_EXCEPT_LINES_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/**
 * Control characters out, trimmed, cut to `max` CODE POINTS (never through a
 * surrogate pair), and `undefined` when nothing is left.
 */
function text(value: string | undefined, max: number, multiline = false): string | undefined {
  if (typeof value !== "string") return undefined;
  const stripped = value.replace(multiline ? CONTROL_EXCEPT_LINES_RE : CONTROL_RE, "").trim();
  const points = Array.from(stripped);
  const capped = points.length > max ? points.slice(0, max).join("").trimEnd() : stripped;
  return capped || undefined;
}

/** An `http(s)` URL, as the URL parser normalises it — anything else is dropped. */
function sourceUrl(value: string | undefined): string | undefined {
  // Uncapped here: a URL cut at the cap is a different URL, so a long one is dropped below.
  const raw = text(value, Number.POSITIVE_INFINITY);
  if (raw === undefined || !URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return url.href.length <= PROVENANCE_LIMITS.source_url ? url.href : undefined;
}

export function cleanProvenance(input: ProvenanceInput): StoredProvenance {
  const remix = slugSchema.safeParse(input.remix_of);
  const fields: StoredProvenance = {
    // A control character becomes a space; `cleanTitle` collapses and caps.
    title: input.title === undefined ? undefined : (cleanTitle(input.title.replace(CONTROL_RE, " ")) ?? undefined),
    model: text(input.model, PROVENANCE_LIMITS.model),
    tool: text(input.tool, PROVENANCE_LIMITS.tool),
    prompt: text(input.prompt, PROVENANCE_LIMITS.prompt, true),
    readme: text(input.readme, PROVENANCE_LIMITS.readme, true),
    sourceUrl: sourceUrl(input.source_url),
    remixOf: remix.success ? remix.data : undefined,
  };
  // Drop the absent keys, so `{}` is what "nothing sent" looks like.
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as StoredProvenance;
}
