/**
 * The founding review link's `t` (E06a §4): who applied, and until when Arun's
 * one-click review may act on it.
 *
 * `t = base64url(expiry ":" email) "." base64url(HMAC-SHA256(KEPT_ADMIN_SECRET,
 * "founding-review\0" + expiry ":" email))`, expiry in Unix seconds,
 * `FOUNDING_REVIEW_TTL_DAYS` after signing. The label keeps a review signature
 * from ever verifying as a waitlist unsubscribe token, which uses the same key
 * (`lib/waitlist/unsubscribe.ts`), and vice versa.
 *
 * Expired and tampered tokens are the same `null` to the caller (410 either way).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { FOUNDING_REVIEW_TTL_DAYS } from "@kept/shared";

import { adminSecret } from "../storage/env";

const LABEL = "founding-review\0";
const DAY_MS = 24 * 60 * 60 * 1000;

function signature(payload: string): Buffer {
  return createHmac("sha256", adminSecret()).update(LABEL + payload).digest();
}

/** The `t` for `email` (already trimmed and lowercased), valid 14 days from `now`. */
export function reviewToken(email: string, now: Date = new Date()): string {
  const expiry = Math.floor((now.getTime() + FOUNDING_REVIEW_TTL_DAYS * DAY_MS) / 1000);
  const payload = `${expiry}:${email}`;
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${signature(payload).toString("base64url")}`;
}

/** The applicant a well-signed, unexpired `t` names, or `null` for anything else. */
export function emailFromReviewToken(token: unknown, now: Date = new Date()): string | null {
  if (typeof token !== "string" || token.length > 1024) return null;
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;

  const payload = Buffer.from(match[1]!, "base64url").toString("utf8");
  const presented = Buffer.from(match[2]!, "base64url");
  const expected = signature(payload);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;

  const fields = /^(\d{1,12}):(.+)$/s.exec(payload);
  if (!fields) return null;
  return Number(fields[1]) * 1000 > now.getTime() ? fields[2]! : null;
}
