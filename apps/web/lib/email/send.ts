/**
 * The ONE place kept hands a mail to Resend. Every sender — the magic link, the
 * draft reminder, waitlist, founding, moderation and operator alerts — composes
 * its message and calls `sendEmail`; none constructs a Resend client.
 *
 * `compose` receives the configured `from`, which the legal footer needs.
 * Throws `${name} — ${message}` on a Resend refusal; the caller decides.
 *
 * `KEPT_EMAIL_DELIVERY=off` (`emailDeliveryOff()`, local origins only) skips
 * the Resend call and nothing else: the configuration is still read, the mail
 * still composed and addressed, and the caller sees a successful send.
 */
import { Resend } from "resend";

import { emailDeliveryOff, resendConfig } from "../storage/env";

export interface Email {
  to: string | string[];
  subject: string;
  text: string;
  replyTo?: string[];
  headers?: Record<string, string>;
}

export async function sendEmail(compose: (from: string) => Email): Promise<void> {
  const { apiKey, from } = resendConfig();
  const email = compose(from);
  if (emailDeliveryOff()) {
    console.log(
      `[kept] mail to ${[email.to].flat().join(", ")} not sent — KEPT_EMAIL_DELIVERY=off: ${email.subject}`,
    );
    return;
  }
  const { error } = await new Resend(apiKey).emails.send({ from, ...email });
  if (error) throw new Error(`${error.name} — ${error.message}`);
}
