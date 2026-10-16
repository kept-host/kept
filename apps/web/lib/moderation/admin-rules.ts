/**
 * The moderation screen's pure rules (E07 §6.11, §9, AC21) — the request
 * bodies of `/api/admin/moderation/*`, the escaped Source cap and the Scanner
 * tab's colour. No server imports: the screen's client components use these
 * too, so the browser and the handlers validate one shape.
 *
 * ── "EACH REQUIRES A REASON" (AC21) ────────────────────────────────────────
 * A restriction (Hide, Remove) takes a reason from `MODERATION_REASONS` — it
 * is what the statement of reasons names — and an optional note. A decision
 * that restricts nothing (Restore, Dismiss, Grant, Reject) has no reason in
 * that list to give, so its reason is the written one: the note is required,
 * and it is what the owner or the reporter reads.
 */
import { ADMIN_SOURCE_PREVIEW_BYTES, moderationReasonEnum } from "@kept/shared";
import { z } from "zod";

import { MS_PER_HOUR } from "../sites/display";

/** The longest note the screen accepts. */
export const ADMIN_NOTE_MAX = 2000;

const note = z.string().trim().max(ADMIN_NOTE_MAX);
const requiredNote = note.min(1, "Write the reason.");
/** An empty optional note is no note. */
const optionalNote = note.optional().transform((value) => (value ? value : undefined));

/** `POST /api/admin/moderation/sites/:id`. */
export const siteActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("restore"), note: requiredNote }),
  z.object({ action: z.literal("hide"), reason: moderationReasonEnum, note: optionalNote }),
  z.object({ action: z.literal("remove"), reason: moderationReasonEnum, note: optionalNote }),
]);
export type SiteAction = z.infer<typeof siteActionSchema>["action"];

/** `POST /api/admin/moderation/reports` — dismiss these reports. */
export const dismissReportsSchema = z.object({
  reportIds: z.array(z.string().uuid()).min(1).max(100),
  note: requiredNote,
});

/** `POST /api/admin/moderation/appeals/:id`. */
export const appealDecisionSchema = z.object({
  decision: z.enum(["grant", "reject"]),
  note: requiredNote,
});

/**
 * The Source tab's text: the first `ADMIN_SOURCE_PREVIEW_BYTES` bytes of the
 * page (a character cut in half at the boundary decodes as U+FFFD). React
 * escapes it as text — it is never parsed as markup.
 */
export function sourcePreview(html: string): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(html);
  if (bytes.length <= ADMIN_SOURCE_PREVIEW_BYTES) return { text: html, truncated: false };
  return { text: new TextDecoder().decode(bytes.subarray(0, ADMIN_SOURCE_PREVIEW_BYTES)), truncated: true };
}

/**
 * Where the item view reads a page's bytes: `preview` (the page as a document,
 * under its own sandboxed, no-network CSP, D-69) or `source` (the text). The
 * "Show" click adds `?show=1` — the explicit intent a child-sexual-abuse item's
 * bytes require (D13); no screen names that URL until the click.
 */
export function adminPageUrl(siteId: string, kind: "preview" | "source", shown = false): string {
  return `/api/admin/moderation/sites/${siteId}/${kind}${shown ? "?show=1" : ""}`;
}

/** Whether a request to `adminPageUrl` carries the "Show" intent. */
export function isShown(url: URL): boolean {
  return url.searchParams.get("show") === "1";
}

export type ScannerLight = "green" | "amber" | "red";

/**
 * The Scanner tab's colour (§9): red when the classifier key is missing, when
 * `scan-retry` never succeeded or its last success is over 24 h old; green
 * under 1 h; amber otherwise. (§9 names amber "over 6 h" and green "under
 * 1 h"; the 1–6 h gap reads amber here — the job runs every 12 minutes, so an
 * hour without a success is already several missed runs.)
 */
export function scannerLight(input: { keyPresent: boolean; lastSuccessAt: Date | null; now: Date }): ScannerLight {
  if (!input.keyPresent || !input.lastSuccessAt) return "red";
  const age = input.now.getTime() - input.lastSuccessAt.getTime();
  if (age > 24 * MS_PER_HOUR) return "red";
  return age < MS_PER_HOUR ? "green" : "amber";
}
