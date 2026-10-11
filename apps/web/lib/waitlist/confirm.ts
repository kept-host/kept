/**
 * Confirming a waitlist address (E06a §3, D1, AC10) — `POST /api/waitlist/confirm`.
 *
 * Only a POST confirms: the `/waitlist/confirm?t=…` page renders a button and
 * changes nothing, because company mail scanners open every link they see.
 *
 * The token is the raw 32-byte base64url value from the mail; only its SHA-256
 * is stored. Anything outside that shape is refused before Postgres.
 */
import { hashToken } from "@kept/shared";

import { confirmWaitlistByTokenHash, type ConfirmedRow } from "../db/queries/waitlist";

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{40,64}$/;

/** The confirmed row, or `null` for an unknown, used or expired token (→ 410). */
export async function confirmWaitlist(raw: unknown): Promise<ConfirmedRow | null> {
  const token =
    raw && typeof raw === "object" && "token" in raw ? (raw as { token: unknown }).token : undefined;
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return null;
  return confirmWaitlistByTokenHash(await hashToken(token));
}
