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
import { NAME_HOLD_DAYS, type NameCheckResult } from "@kept/shared";

/**
 * How long a released chosen name is held for its last owner, in words —
 * `NAME_HOLD_DAYS` as months ("12 months"), the unit PRD §5.4 and §11 speak in.
 */
export const NAME_HOLD_PERIOD = `${Math.round((NAME_HOLD_DAYS * 12) / 365)} months`;

/**
 * The rename dialog's warning, said before the name moves (PRD §5.4). The hold
 * sentence only when the old name was CHOSEN — a generated name is not held
 * (D4), so promising a hold on it would be false.
 */
export function renameWarning(oldHost: string, oldNameChosen: boolean): string {
  const hold = oldNameChosen ? ` Nobody else can take that name for ${NAME_HOLD_PERIOD}.` : "";
  return `The old link ${oldHost} stops working within about 2 minutes.${hold}`;
}

/** A draft's Name section, where the button would be (PRD §5.2, AC17). */
export const DRAFT_NAME_NOTE = "Keep this page to give it a name. Drafts get a generated one.";

/** The name quota, as the Name section states it (PRD §5.2). */
export function namesUsed(count: number, quota: number): string {
  return `Names · ${count} of ${quota} used`;
}

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
