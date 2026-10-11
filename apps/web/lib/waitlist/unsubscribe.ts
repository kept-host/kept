/**
 * Leaving the waitlist (E06a §3, AC11): the signed per-address token, and the
 * one effect every unsubscribe door has.
 *
 * THE TOKEN IS AN HMAC, NOT A COLUMN (recorded deviation from the PRD's data
 * model, audit §2). `t = base64url(email) "." base64url(HMAC-SHA256(
 * KEPT_ADMIN_SECRET, "waitlist-unsubscribe\0" + email))`. Stable per address,
 * unguessable without the secret, and needs no schema change; the address
 * rides in the token because an HMAC cannot be looked up. It is the
 * recipient's own address in the recipient's own link, served with
 * `referrer-policy: no-referrer`. The label keeps it from ever verifying as a
 * founding review signature, which uses the same key (006).
 *
 * Rotating `KEPT_ADMIN_SECRET` invalidates every unsubscribe link already
 * mailed; the mail's own visible link still lands on a page that says so.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { unsubscribeWaitlistEmail } from "../db/queries/waitlist";
import { adminSecret } from "../storage/env";

const LABEL = "waitlist-unsubscribe\0";

function signature(email: string): Buffer {
  return createHmac("sha256", adminSecret()).update(LABEL + email).digest();
}

/** The `t` for `email` (already trimmed and lowercased). */
export function unsubscribeToken(email: string): string {
  return `${Buffer.from(email, "utf8").toString("base64url")}.${signature(email).toString("base64url")}`;
}

/** The address a well-signed `t` names, or `null` for anything else. */
export function emailFromUnsubscribeToken(token: unknown): string | null {
  if (typeof token !== "string" || token.length > 1024) return null;
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const email = Buffer.from(match[1]!, "base64url").toString("utf8");
  const presented = Buffer.from(match[2]!, "base64url");
  const expected = signature(email);
  return presented.length === expected.length && timingSafeEqual(presented, expected)
    ? email
    : null;
}

/**
 * Set `unsubscribed_at` for the address `token` names. One answer for every
 * token, valid or not: the caller says "You're off the list." either way, so
 * the URL is not an oracle for who is on the list.
 */
export async function unsubscribeWaitlist(token: unknown): Promise<void> {
  const email = emailFromUnsubscribeToken(token);
  if (email) await unsubscribeWaitlistEmail(email);
}
