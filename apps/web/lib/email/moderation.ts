/**
 * Moderation mail (E07 §6.9, §6.10): the statement of reasons an owner gets on
 * every restriction and every restore, the answer to a rejected appeal, and the
 * operator alerts `lib/moderation` sends through `sendAdminAlert`.
 *
 * COPY RULES (§9): short, calm, blameless — the owner may be innocent and the
 * check may be wrong. Never the scanner's rule, never a probability; those are
 * for the admin screen. The "why" is `MODERATION_REASON_SENTENCES`, verbatim,
 * with the acceptable-use rule it falls under.
 *
 * Every link is built from configuration (`appOrigin()`, the page URL from
 * `servingBaseDomain()`), never from a request. The builders are pure; the
 * sender throws on a Resend refusal and the caller decides. Nothing here logs.
 */
import {
  ABUSE_CONTACT_EMAIL,
  MODERATION_REASON_SENTENCES,
  type ModerationActor,
  type ModerationReason,
  type SiteStatus,
} from "@kept/shared";
import { Resend } from "resend";

import { resendConfig } from "../storage/env";
import type { AdminAlert } from "./admin-alert";
import { formatUtcDate } from "./draft-reminder";
import { emailFooter } from "./footer";
import { apexUrl } from "./waitlist";

export interface ModerationEmail {
  subject: string;
  text: string;
}

/** The four statuses a moderation change can land on. */
export type ModeratedStatus = Extract<SiteStatus, "under_review" | "quarantined" | "removed" | "live">;

export interface StatementInput {
  to: ModeratedStatus;
  /** `https://{slug}.{KEPT_BASE_DOMAIN}`. */
  pageUrl: string;
  siteId: string;
  /** Why it was restricted — on a restore, what it had been restricted for. */
  reason: ModerationReason | null;
  actor: ModerationActor;
  automated: boolean;
  /** The reviewer's note; only a person's note is ever shown. */
  note: string | null;
  /** The restore answers this owner's own request for a review. */
  appealGranted: boolean;
  /** Owned pages get a studio link and a download; anonymous ones neither. */
  owned: boolean;
  /** On a removal: when the page is deleted for good. */
  purgeAfter: Date | null;
  /** The control plane's origin (`appOrigin()`). */
  origin: string;
  from: string;
}

const SUBJECTS: Record<ModeratedStatus, string> = {
  under_review: "Your kept page is hidden while we check it",
  quarantined: "Your kept page is hidden",
  removed: "Your kept page was removed",
  live: "Your kept page is back online",
};

function lead(to: ModeratedStatus, pageUrl: string): string {
  switch (to) {
    case "under_review":
      return `We've hidden your page ${pageUrl} while we take a look.`;
    case "quarantined":
      return `We've hidden your page ${pageUrl}.`;
    case "removed":
      return `We've removed your page ${pageUrl}.`;
    case "live":
      return `Your page ${pageUrl} is back online.`;
  }
}

/** The "why": Appendix A's sentence and the acceptable-use rule it falls under. */
export function reasonParagraph(reason: ModerationReason, origin: string): string {
  const { sentence, aupSection } = MODERATION_REASON_SENTENCES[reason];
  const rules = apexUrl("/legal/acceptable-use", origin);
  return aupSection === null
    ? `Why: ${sentence} Our acceptable-use rules: ${rules}`
    : `Why: ${sentence} This falls under rule ${aupSection} of our acceptable-use rules: ${rules}`;
}

function howDecided(actor: ModerationActor, automated: boolean): string {
  switch (actor) {
    case "scanner":
      return "How we decided: an automated check flagged it. Nobody has reviewed it yet.";
    case "report":
      return "How we decided: it was reported, and pages reported for this are hidden automatically. Nobody has reviewed it yet.";
    case "admin":
      return automated
        ? "How we decided: an automated check flagged it, and a person reviewed it."
        : "How we decided: a person reviewed it.";
  }
}

/** Where the owner asks for a review: the studio page, or the link they hold. */
function whatYouCanDo(input: StatementInput): string {
  const where = input.owned
    ? `ask for a review here: ${input.origin}/site/${input.siteId}`
    : "open the private link you were given when you published the page and ask for a review there";
  return `What you can do: if you think we got this wrong, ${where}. You can also write to ${ABUSE_CONTACT_EMAIL}.`;
}

function deletionParagraph(input: StatementInput): string | null {
  if (input.to !== "removed" || !input.purgeAfter) return null;
  const date = formatUtcDate(input.purgeAfter);
  // Never a download for child sexual abuse material (D13).
  return input.owned && input.reason !== "child_sexual_abuse"
    ? `You can still download it from that page until ${date}. After that it's deleted for good.`
    : `It will be deleted for good on ${date}.`;
}

/** The statement of reasons (§6.9). Pure. */
export function buildStatementOfReasons(input: StatementInput): ModerationEmail {
  const paragraphs: (string | null)[] = [lead(input.to, input.pageUrl)];

  if (input.to === "live") {
    if (input.appealGranted) paragraphs.push("We looked at your request for a review, and we agree.");
    paragraphs.push(howDecided(input.actor, input.automated));
  } else {
    if (input.reason) paragraphs.push(reasonParagraph(input.reason, input.origin));
    paragraphs.push(howDecided(input.actor, input.automated));
  }
  if (input.actor === "admin" && input.note) paragraphs.push(`A note from the person who reviewed it: ${input.note}`);
  if (input.to !== "live") {
    paragraphs.push(deletionParagraph(input));
    paragraphs.push(whatYouCanDo(input));
  }

  return {
    subject: SUBJECTS[input.to],
    text: `${paragraphs.filter((p): p is string => p !== null).join("\n\n")}\n\n${emailFooter({ from: input.from, origin: input.origin }).text}`,
  };
}

/** The answer to a rejected appeal (§6.10). Pure. */
export function buildAppealRejectedEmail(input: {
  pageUrl: string;
  note: string;
  status: SiteStatus;
  purgeAfter: Date | null;
  origin: string;
  from: string;
}): ModerationEmail {
  const paragraphs = [
    `We looked at your request for a review of ${input.pageUrl} again, and the decision stands.`,
    `A note from the person who reviewed it: ${input.note}`,
    input.status === "removed" && input.purgeAfter
      ? `The page will be deleted for good on ${formatUtcDate(input.purgeAfter)}.`
      : "The page stays hidden.",
    `Questions? Write to ${ABUSE_CONTACT_EMAIL}.`,
  ];
  return {
    subject: "Your review request was answered",
    text: `${paragraphs.join("\n\n")}\n\n${emailFooter({ from: input.from, origin: input.origin }).text}`,
  };
}

/** Send one moderation mail to one owner. Throws on a Resend refusal. */
export async function sendModerationEmail(
  recipient: string,
  build: (from: string) => ModerationEmail,
): Promise<void> {
  const { apiKey, from } = resendConfig();
  const message = build(from);
  const { error } = await new Resend(apiKey).emails.send({
    from,
    to: recipient,
    subject: message.subject,
    text: message.text,
  });
  if (error) throw new Error(`${error.name} — ${error.message}`);
}

const ALERT_VERBS: Record<ModeratedStatus, string> = {
  under_review: "flagged",
  quarantined: "hidden",
  removed: "removed",
  live: "restored",
};

/**
 * The operator alert for a change the scanner or a report made (§6.7 step 4).
 * Child sexual abuse material is a PRIORITY alert (P2 and the report fast path).
 */
export function moderationAlert(input: {
  slug: string;
  pageUrl: string;
  from: SiteStatus;
  to: ModeratedStatus;
  actor: ModerationActor;
  reason: ModerationReason | null;
  scanId: string | null;
  reportId: string | null;
  origin: string;
}): AdminAlert {
  return {
    subject: `${input.slug} ${ALERT_VERBS[input.to]} by ${input.actor === "scanner" ? "the scanner" : "a report"}`,
    priority: input.reason === "child_sexual_abuse",
    lines: [
      `Page: ${input.pageUrl}`,
      `Status: ${input.from} → ${input.to}`,
      `Reason: ${input.reason ?? "none"}`,
      ...(input.scanId ? [`Scan: ${input.scanId}`] : []),
      ...(input.reportId ? [`Report: ${input.reportId}`] : []),
      `Review it: ${input.origin}/admin/moderation`,
    ],
  };
}

/** The operator alert for a submitted appeal (§6.10). */
export function appealAlert(input: {
  slug: string;
  pageUrl: string;
  status: SiteStatus;
  reason: ModerationReason | null;
  message: string;
  anonymous: boolean;
  origin: string;
}): AdminAlert {
  return {
    subject: `Appeal on ${input.slug}`,
    priority: input.reason === "child_sexual_abuse",
    lines: [
      `Page: ${input.pageUrl}`,
      `Status: ${input.status} (reason: ${input.reason ?? "none"})`,
      `From: ${input.anonymous ? "the anonymous publisher (token)" : "the owner (studio)"}`,
      `Their words:\n${input.message}`,
      `Decide it: ${input.origin}/admin/moderation`,
    ],
  };
}
