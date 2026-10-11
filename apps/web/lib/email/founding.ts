/**
 * Founding mail (E06a §4): the application notice to every `KEPT_ADMIN_EMAILS`
 * address, and the approval sent to the creator.
 *
 * Same sender as the magic link (`resendConfig().from`, Arun 2026-10-11); every
 * link is built from configuration (`apexUrl`), never a request. The approval
 * is a reply to the application, not marketing: replies go to the admins, and
 * it carries the waitlist's `List-Unsubscribe` pair and visible link like every
 * later waitlist mail. The admin notice is operator mail to Arun — no
 * unsubscribe, since he would be unsubscribing from his own review queue.
 *
 * Throws on a Resend refusal; the caller decides. Nothing here logs.
 */
import { Resend } from "resend";

import type { FoundingApplication } from "../db/queries/founding";
import { appOrigin, resendConfig } from "../storage/env";
import { emailFooter } from "./footer";
import { apexUrl, waitlistUnsubscribe } from "./waitlist";

export interface FoundingEmail {
  subject: string;
  text: string;
}

/** The notice Arun gets once an application is confirmed. */
export function buildApplicationEmail({
  application,
  reviewUrl,
  from,
  origin,
}: {
  application: Pick<FoundingApplication, "email" | "socialUrl" | "note">;
  reviewUrl: string;
  from: string;
  origin: string;
}): FoundingEmail {
  return {
    subject: `Founding application: ${application.socialUrl}`,
    text:
      `Email: ${application.email}\n` +
      `Social: ${application.socialUrl}\n` +
      `What they make with AI: ${application.note || "(no note)"}\n\n` +
      `Review (approve or decline):\n${reviewUrl}\n\n` +
      emailFooter({ from, origin }).text,
  };
}

/** PRD §4, verbatim. */
export const APPROVAL_SUBJECT = "You're a kept founding creator";
const APPROVAL_BODY =
  "You're in. kept opens in December, and you'll get Pro free from day one. We'll email you the moment you can sign in. Use this email address when you do.\n\n" +
  'There\'s no obligation to post about kept. If you do, please mark the post as an ad (in Germany: "Werbung" or "Anzeige"), since you got Pro for free.\n\n' +
  "Questions? Just reply. This goes to Arun.";

export function buildApprovalEmail({
  unsubscribeUrl,
  from,
  origin,
}: {
  unsubscribeUrl: string;
  from: string;
  origin: string;
}): FoundingEmail {
  return {
    subject: APPROVAL_SUBJECT,
    text:
      `${APPROVAL_BODY}\n\n` +
      `Unsubscribe from kept mail: ${unsubscribeUrl}\n\n` +
      emailFooter({ from, origin }).text,
  };
}

/** Mail the application to `admins` (one send, every address on `to`). */
export async function sendApplicationEmail(
  admins: string[],
  application: Pick<FoundingApplication, "email" | "socialUrl" | "note">,
  reviewToken: string,
): Promise<void> {
  const { apiKey, from } = resendConfig();
  const origin = appOrigin();
  const reviewUrl = apexUrl(`/founding/review?t=${encodeURIComponent(reviewToken)}`, origin);
  const message = buildApplicationEmail({ application, reviewUrl, from, origin });
  const { error } = await new Resend(apiKey).emails.send({
    from,
    to: admins,
    subject: message.subject,
    text: message.text,
  });
  if (error) throw new Error(`${error.name} — ${error.message}`);
}

/** Tell the creator they are in. Replies go to `admins`. */
export async function sendApprovalEmail(email: string, admins: string[]): Promise<void> {
  const { apiKey, from } = resendConfig();
  const origin = appOrigin();
  const unsubscribe = waitlistUnsubscribe(email, origin);
  const message = buildApprovalEmail({ unsubscribeUrl: unsubscribe.url, from, origin });
  const { error } = await new Resend(apiKey).emails.send({
    from,
    to: email,
    ...(admins.length > 0 ? { replyTo: admins } : {}),
    subject: message.subject,
    text: message.text,
    headers: unsubscribe.headers,
  });
  if (error) throw new Error(`${error.name} — ${error.message}`);
}
