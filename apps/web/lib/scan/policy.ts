/**
 * The scan policy (E07 PRD §6.4): facts + classifier answers → clean or flag.
 *
 * PURE. No I/O and no clock, so the eval and any threshold change replay saved
 * answers without a new classifier call. Thresholds are passed in — the default
 * is `SCAN_THRESHOLDS`; the eval sets the final values there.
 *
 * `answers = null` means the classifier is off (no `OPENROUTER_API_KEY`, D17) or
 * failed (edge case 1): only the deterministic P4 can fire.
 */
import { SCAN_THRESHOLDS, type ModerationReason, type ScanThresholds } from "@kept/shared";

import type { ClassifierAnswers, HarmChoice, PageFacts, PolicyDecision } from "./types";

/** P1's harmful `harm` choices and the reason each is recorded as (PRD Appendix A). */
const HARM_REASONS = {
  credential_phishing: "phishing",
  payment_harvest: "payment_fraud",
  wallet_drainer: "crypto_scam",
  malware_download: "malware",
  scam: "scam",
} as const satisfies Partial<Record<HarmChoice, ModerationReason>>;

function isHarmReasonChoice(choice: HarmChoice): choice is keyof typeof HARM_REASONS {
  return Object.hasOwn(HARM_REASONS, choice);
}

export function decide(
  facts: Pick<PageFacts, "secretField" | "secretsLeavePage" | "obfuscated">,
  answers: ClassifierAnswers | null,
  thresholds: ScanThresholds = SCAN_THRESHOLDS,
): PolicyDecision {
  if (answers) {
    const { choice, probabilities } = answers.harm;
    const confidence = probabilities[choice] ?? 0;

    // P2 — child sexual abuse material: the lower threshold and the priority alert.
    if (choice === "sexual_content_minors" && confidence >= thresholds.minors) {
      return { verdict: "flag", reason: "child_sexual_abuse", rule: "P2", priority: true };
    }
    // P1 — a confident harmful pick.
    if (isHarmReasonChoice(choice) && confidence >= thresholds.harm) {
      return { verdict: "flag", reason: HARM_REASONS[choice], rule: "P1", priority: false };
    }
    // P3 — secrets leave the page of something that presents itself as someone else.
    if (facts.secretsLeavePage && answers.impersonates.noul >= thresholds.impersonates) {
      return { verdict: "flag", reason: "phishing", rule: "P3", priority: false };
    }
  }
  // P4 — deterministic: hidden code on a page that asks for a secret.
  if (facts.obfuscated && facts.secretField) {
    return { verdict: "flag", reason: "suspicious_code", rule: "P4", priority: false };
  }
  return { verdict: "clean" };
}
