/**
 * The name field's words (PRD §5.4) — one sentence per check status.
 *
 * ⚠️ BROWSER-SAFE AND PURE. The rename field renders these as you type, and the
 * rename route puts the same sentence in its refusal, so the field and the
 * server can never say two different things about one name. No database, no
 * environment: the caller passes the host suffix it already has.
 *
 * Every number is interpolated from the check result, which reads it from
 * `limitsFor(plan)` and the database (PRD §11) — a limit typed into a sentence
 * here would be a second source E11 could not change.
 */
import type { NameCheckResult } from "@kept/shared";

/**
 * The sentence for one check result about `name`. `hostSuffix` is the dot and
 * the serving base domain (`.kept.host`), only used by `available`.
 *
 * `quota` carries no Pro clause: D15 renders that clause only with the locked
 * CTA, which has no destination until E11 sets `NEXT_PUBLIC_LOCKED_CTA_URL`.
 */
export function nameStatusMessage(
  result: NameCheckResult,
  name: string,
  hostSuffix: string,
): string {
  switch (result.status) {
    case "invalid":
      return "Use lowercase letters, numbers and single hyphens.";
    case "too_short":
      return `Names need at least ${result.min} characters.`;
    case "pro_length":
      return `${name.length}-letter names come with Pro.`;
    case "reserved":
      return "That name is reserved.";
    case "inappropriate":
      return "kept doesn't put that word in a URL. Try another name.";
    case "held_for_you":
      return "You used this name before — it's yours to take back.";
    case "taken":
      return "That name is taken.";
    case "quota":
      return `You've used ${result.count} of ${result.quota} names. Delete a named page to free one.`;
    case "rate_limited":
      return `You've changed names ${result.count} times today. Try again tomorrow.`;
    case "available":
      return `${name}${hostSuffix} is free`;
  }
}
