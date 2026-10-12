/**
 * Arun's one-click review of a founding application (E06a §4, AC13).
 *
 *   GET  /founding/review?t=…   → `readFoundingReview`: the card, changes nothing
 *                                  (mail scanners open every link)
 *   POST /api/founding/review   → `decideFoundingReview`: approve or decline
 *
 * The signed `t` is the authority (`review-token.ts`). Approve sets `approved`
 * + `founding_decided_at` and mails the creator; decline sets `declined` and
 * mails nobody. Both are idempotent: deciding what is already decided changes
 * and sends nothing. An expired or tampered `t`, or an application that is
 * gone, is `expired` (→ 410, "Use `admin:founding add` instead."). A refused
 * approval mail rolls the decision back (`mail_failed` → 502), so a retry sends it.
 */
import {
  decideFounding,
  foundingApplication,
  type FoundingApplication,
} from "../db/queries/founding";
import { sendApprovalEmail } from "../email/founding";
import { adminEmails } from "../storage/env";
import { emailFromReviewToken } from "./review-token";

export const DECISIONS = { approve: "approved", decline: "declined" } as const;
export type Decision = keyof typeof DECISIONS;

/** The application `t` names, or `null` for a bad, expired or orphaned link. */
export async function readFoundingReview(t: unknown): Promise<FoundingApplication | null> {
  const email = emailFromReviewToken(t);
  return email ? foundingApplication(email) : null;
}

export type ReviewOutcome =
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "mail_failed" }
  | { kind: "decided"; status: (typeof DECISIONS)[Decision]; emailed: boolean };

export async function decideFoundingReview(raw: unknown): Promise<ReviewOutcome> {
  const body = raw && typeof raw === "object" ? (raw as { t?: unknown; decision?: unknown }) : {};
  if (body.decision !== "approve" && body.decision !== "decline") return { kind: "invalid" };

  const email = emailFromReviewToken(body.t);
  if (!email) return { kind: "expired" };

  const status = DECISIONS[body.decision];
  let result: Awaited<ReturnType<typeof decideFounding>>;
  try {
    result = await decideFounding(email, status, async (decided) => {
      if (status === "approved") await sendApprovalEmail(decided.email, [...adminEmails()]);
    });
  } catch (err) {
    // The decision rolled back with the failed send, so pressing Approve again retries both.
    console.error(
      `[kept] founding: approval mail failed, decision rolled back — ${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: "mail_failed" };
  }
  if (result === "missing") return { kind: "expired" };
  return { kind: "decided", status, emailed: result === "changed" && status === "approved" };
}
