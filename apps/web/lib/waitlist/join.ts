/**
 * Joining the waitlist with double opt-in (E06a §3, §5) — `POST /api/waitlist`.
 * The route is the HTTP boundary; this module decides, in this order:
 *
 *   1. per-IP limit (every request counts, malformed ones too)   → 429
 *   2. the body (`waitlistJoinSchema`)                           → 400
 *   3. Turnstile                                                 → 400
 *   4. the global confirmation-mail cap, PEEKED — checked before
 *      the row is read, so a 429 says nothing about the address  → 429
 *   5. the upsert (`upsertWaitlistJoin`) decides whether to send
 *   6. a send counts against the global cap, then mails
 *
 * Everything past step 4 answers the SAME 202 `{ status: "check_inbox" }`:
 * new, pending, cooling down, capped for the day, confirmed or unsubscribed —
 * the response never says which (AC9).
 *
 * A Resend failure does not change the 202. The row keeps `confirm_sent_at`, so
 * the next try after the 10-minute cooldown sends again; the failure is logged
 * without the address or the token (AC24).
 *
 * `founding` is accepted by the schema and ignored here; task 006 adds it.
 */
import {
  RATE_LIMITS,
  generateAnonToken,
  hashToken,
  waitlistJoinSchema,
} from "@kept/shared";

import { upsertWaitlistJoin } from "../db/queries/waitlist";
import { sendConfirmationEmail } from "../email/waitlist";
import { verifyTurnstile } from "../publish/hooks";
import type { PublishFailure } from "../publish/pipeline";
import { hit, ipKey, peek } from "../rate-limit";

/** The fixed bucket every confirmation mail counts against. */
export const CONFIRMATION_MAILS_BUCKET = "waitlist-confirm-mail:global";

export const CHECK_INBOX = { status: "check_inbox" } as const;

export type WaitlistOutcome =
  | { ok: true; status: 202; body: typeof CHECK_INBOX }
  | PublishFailure;

function tooMany(retryAfterSeconds: number): PublishFailure {
  return {
    ok: false,
    status: 429,
    body: {
      error: "rate_limited",
      message: "Too many tries, try again in a bit.",
      retry_after_seconds: retryAfterSeconds,
    },
  };
}

export async function joinWaitlist(raw: unknown, clientIp: string): Promise<WaitlistOutcome> {
  const perIp = await hit(await ipKey("waitlist", clientIp), RATE_LIMITS.waitlistPerIp);
  if (!perIp.allowed) return tooMany(perIp.retryAfterSeconds);

  const parsed = waitlistJoinSchema.safeParse(raw);
  if (!parsed.success) {
    const emailBad = parsed.error.issues.some((issue) => issue.path[0] === "email");
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid_request",
        message: emailBad ? "Enter a valid email address." : "That request wasn't valid.",
      },
    };
  }

  const turnstile = await verifyTurnstile(parsed.data.turnstileToken, clientIp);
  if (!turnstile.ok) {
    return {
      ok: false,
      status: 400,
      body: { error: "turnstile_failed", message: "The verification didn't pass. Try it again." },
    };
  }

  const global = await peek(CONFIRMATION_MAILS_BUCKET, RATE_LIMITS.confirmationMailsGlobal);
  if (!global.allowed) return tooMany(global.retryAfterSeconds);

  const token = generateAnonToken();
  const send = await upsertWaitlistJoin({
    email: parsed.data.email,
    source: parsed.data.source,
    tokenHash: await hashToken(token),
  });

  if (send) {
    await hit(CONFIRMATION_MAILS_BUCKET, RATE_LIMITS.confirmationMailsGlobal);
    try {
      await sendConfirmationEmail(parsed.data.email, token);
    } catch (err) {
      console.error(
        `[kept] waitlist: confirmation mail failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { ok: true, status: 202, body: CHECK_INBOX };
}
