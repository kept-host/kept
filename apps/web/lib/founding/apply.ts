/**
 * Telling Arun about a founding application (E06a §4, AC12). Called from the
 * two places an application becomes real: `confirmWaitlist`, the moment a
 * pending applicant confirms, and `joinWaitlist`, when the address applying was
 * already confirmed. Unconfirmed applications never get here.
 *
 * Never throws: the applicant's answer does not depend on Arun's inbox. A
 * failure is logged without the address, URL or token (AC24).
 */
import type { FoundingApplication } from "../db/queries/founding";
import { sendApplicationEmail } from "../email/founding";
import { adminEmails } from "../storage/env";
import { reviewToken } from "./review-token";

export async function notifyFoundingApplication(
  application: Pick<FoundingApplication, "email" | "socialUrl" | "note">,
): Promise<void> {
  const admins = [...adminEmails()];
  if (admins.length === 0) {
    console.error("[kept] founding: application not sent — KEPT_ADMIN_EMAILS is empty");
    return;
  }
  try {
    await sendApplicationEmail(admins, application, reviewToken(application.email));
  } catch (err) {
    console.error(
      `[kept] founding: application mail failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
