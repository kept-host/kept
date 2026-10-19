/**
 * The HTTP shape of `POST /api/reports` (E07 §6.8): `201 { ok: true }` or the
 * `reportErrorSchema` envelope — `400 invalid` · `400 turnstile_failed` ·
 * `422 not_a_kept_page` · `429 rate_limited` (+ `Retry-After`). Every decision
 * is `./submit.ts`'s. The answer never says what a report did to the page.
 */
import {
  ABUSE_CONTACT_EMAIL,
  REPORT_DETAILS_MAX,
  REPORT_DETAILS_MIN,
  reportErrorSchema,
  type ReportErrorCode,
} from "@kept/shared";
import { NextResponse } from "next/server";

import type { ReportOutcome } from "./submit";

const STATUS: Record<ReportErrorCode, number> = {
  invalid: 400,
  turnstile_failed: 400,
  not_a_kept_page: 422,
  rate_limited: 429,
};

const MESSAGES: Record<ReportErrorCode, string> = {
  invalid: `Check the form: a link, what's wrong, ${REPORT_DETAILS_MIN} to ${REPORT_DETAILS_MAX} characters on why, and the good-faith box. Or email ${ABUSE_CONTACT_EMAIL}.`,
  turnstile_failed: "The verification didn't pass. Try it again.",
  not_a_kept_page: "That link isn't a kept page.",
  rate_limited: "Too many reports from here — try again later.",
};

const NO_STORE = { "cache-control": "no-store" };

export function reportRefusal(code: ReportErrorCode, retryAfterSeconds?: number): NextResponse {
  const body = reportErrorSchema.parse({
    error: { code, message: MESSAGES[code] },
    ...(retryAfterSeconds ? { retry_after_seconds: retryAfterSeconds } : {}),
  });
  return NextResponse.json(body, {
    status: STATUS[code],
    headers: retryAfterSeconds ? { ...NO_STORE, "retry-after": String(retryAfterSeconds) } : NO_STORE,
  });
}

export function reportResponse(outcome: ReportOutcome): NextResponse {
  if (!outcome.ok) {
    return reportRefusal(outcome.code, outcome.code === "rate_limited" ? outcome.retryAfterSeconds : undefined);
  }
  return NextResponse.json({ ok: true }, { status: 201, headers: NO_STORE });
}
