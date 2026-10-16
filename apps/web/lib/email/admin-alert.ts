/**
 * Operator mail to every `KEPT_ADMIN_EMAILS` address (E07) — the ONE helper for
 * the global publish cap tripping, scanner and report alerts, a submitted
 * appeal, a re-purge that gave up. A second copy is how two alerts end up with
 * two throttles and two ideas of who the operators are.
 *
 * Same sender as every other kept mail (`resendConfig()`), the legal footer, no
 * unsubscribe: it is Arun's own review queue, like the founding notice.
 *
 * THROTTLED THROUGH `lib/rate-limit` when the caller names a bucket and a rule:
 * a flood that trips the same condition a thousand times an hour is one mail,
 * not a thousand — and the throttle is a Postgres counter, so it holds across
 * Railway instances. The throttle is spent BEFORE the recipients are read, so
 * "throttled" never depends on how the deploy is configured.
 *
 * NEVER THROWS, and the outcome says what happened. Every caller is on a path
 * whose answer must not depend on Arun's inbox. Failures are logged by subject
 * only: callers put no address, IP or token in `subject` or `lines`, and this
 * module never logs either.
 */
import type { RateLimitRule } from "@kept/shared";

import { hit } from "../rate-limit";
import { adminEmails, appOrigin } from "../storage/env";
import { emailFooter } from "./footer";
import { sendEmail } from "./send";

export type AdminAlert = {
  subject: string;
  /** Child sexual abuse material: the mail's subject STARTS with `PRIORITY` (§6.8). */
  priority?: boolean;
  /** The body, one paragraph per line. No email, IP or token. */
  lines: string[];
} & (
  | { throttleKey: string; throttle: RateLimitRule }
  | { throttleKey?: undefined; throttle?: undefined }
);

export type AdminAlertOutcome = "sent" | "throttled" | "no_recipients" | "failed";

export interface AdminAlertEmail {
  subject: string;
  text: string;
}

/**
 * Pure: the subject carries a fixed prefix so the alerts filter as one stream;
 * a priority alert puts `PRIORITY` before it, so it starts the subject line.
 */
export function buildAdminAlertEmail({
  subject,
  priority = false,
  lines,
  from,
  origin,
}: {
  subject: string;
  priority?: boolean;
  lines: string[];
  from: string;
  origin: string;
}): AdminAlertEmail {
  return {
    subject: `${priority ? "PRIORITY " : ""}[kept alert] ${subject}`,
    text: `${lines.join("\n\n")}\n\n${emailFooter({ from, origin }).text}`,
  };
}

/** The throttle bucket for `throttleKey`, namespaced apart from every route's. */
export function adminAlertBucket(throttleKey: string): string {
  return `admin-alert:${throttleKey}`;
}

export async function sendAdminAlert(alert: AdminAlert): Promise<AdminAlertOutcome> {
  try {
    if (alert.throttleKey !== undefined) {
      const allowed = await hit(adminAlertBucket(alert.throttleKey), alert.throttle);
      if (!allowed.allowed) return "throttled";
    }

    const admins = [...adminEmails()];
    if (admins.length === 0) {
      console.error(`[kept] admin alert "${alert.subject}" not sent — KEPT_ADMIN_EMAILS is empty`);
      return "no_recipients";
    }

    await sendEmail((from) => ({
      to: admins,
      ...buildAdminAlertEmail({
        subject: alert.subject,
        priority: alert.priority,
        lines: alert.lines,
        from,
        origin: appOrigin(),
      }),
    }));
    return "sent";
  } catch (err) {
    console.error(
      `[kept] admin alert "${alert.subject}" failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    return "failed";
  }
}
