// @kept/shared — provenance (E09 D10, D-34): the optional "how this page was
// made" fields every publish accepts — keyless `/api/publish`, `/api/anon/*`
// replace, the studio, `/api/v1/pages` and the MCP tools. Stored on `sites`;
// E10 shows them, E09 only records them.
//
// Its own module, not part of ./agents, because ./publish spreads the shape
// into `publishOptionsShape` while ./agents imports ./publish — one file would
// be an import cycle that evaluates `PUBLISH_ERROR_CODES` before it exists.

import { z } from "zod";

import { PAGE_TITLE_MAX_LENGTH } from "./constants";
import { slugSchema } from "./schemas";

/** Longest value of each provenance field, in characters (also a DB CHECK). */
export const PROVENANCE_LIMITS = {
  model: 80,
  tool: 80,
  prompt: 8_000,
  readme: 20_000,
  source_url: 2_048,
} as const;

/** Trimmed, capped free text; an empty string is "not given", never a refusal. */
function provenanceText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || undefined)
    .optional();
}

/**
 * The provenance fields, spread into a request object's shape (a zod union has
 * no `.extend`, so the shape travels, not a schema). `spa` is not here: it
 * already lives on the files and upload envelopes (./publish).
 */
export const provenanceShape = {
  /** Stored with `title_source = 'owner'`, outranking the extracted `<title>` (Q7). */
  title: provenanceText(PAGE_TITLE_MAX_LENGTH),
  /** The model that wrote the page, e.g. `claude-opus-4-7`. */
  model: provenanceText(PROVENANCE_LIMITS.model),
  /** The tool or agent that published it, e.g. `codex`. */
  tool: provenanceText(PROVENANCE_LIMITS.tool),
  prompt: provenanceText(PROVENANCE_LIMITS.prompt),
  readme: provenanceText(PROVENANCE_LIMITS.readme),
  /** Where the source lives — an `http(s)` URL. */
  source_url: z
    .string()
    .trim()
    .max(PROVENANCE_LIMITS.source_url)
    .url()
    .refine((value) => /^https?:\/\//i.test(value), "source_url must be an http(s) URL.")
    .optional(),
  /**
   * The SLUG of the page this one remixes (Q8, E10 D7). The publish pipeline
   * resolves it to a site id and stores it only when that page is kept and
   * live; any other slug is dropped silently, never refused.
   */
  remix_of: slugSchema.optional(),
};

