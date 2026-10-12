/**
 * `POST /api/founding/review` — `{ t, decision: "approve" | "decline" }` →
 * 200 `{ status }`, 400 for a bad decision, 410 for an expired or tampered
 * link, 502 when the approval mail is refused (nothing changed). The buttons on
 * `/founding/review` are its only caller; a GET never decides (E06a §4, AC13).
 *
 * Unauthenticated: the HMAC-signed `t` is the authority. Answers on open and
 * closed deploys alike (`CLOSED_API_PATHS`).
 */
import { NextResponse } from "next/server";

import { decideFoundingReview } from "../../../../lib/founding/review";
import { errorResponse, readJsonOnlyBody, UnreadableBodyError } from "../../../../lib/publish/http";

/** `postgres-js` needs TCP sockets, and Resend's SDK is a node client. */
export const runtime = "nodejs";

/** Writes a row and may send mail. Never cacheable. */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

const answer = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: NO_STORE });

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown = null;
  try {
    body = await readJsonOnlyBody(request);
  } catch (err) {
    if (!(err instanceof UnreadableBodyError)) throw err;
  }

  const outcome = await decideFoundingReview(body);
  switch (outcome.kind) {
    case "invalid":
      return errorResponse(400, {
        error: "invalid_request",
        message: "Send a decision of approve or decline.",
      });
    case "expired":
      return answer(410, {
        error: "expired",
        message: "This review link has expired. Use `admin:founding add` instead.",
      });
    case "mail_failed":
      return answer(502, {
        error: "mail_failed",
        message: "The approval mail didn't send, so nothing changed. Try again.",
      });
    case "decided":
      return answer(200, { status: outcome.status, emailed: outcome.emailed });
  }
}
