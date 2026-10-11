/**
 * `POST /api/waitlist` — `{ email, source, turnstileToken, founding? }` onto
 * the waitlist with double opt-in (E06a §3). The decisions are
 * `lib/waitlist/join.ts`'s; this is the HTTP boundary.
 *
 * Answers on open and closed deploys alike (`CLOSED_API_PATHS`). No session and
 * no origin gate: it reads no cookie and writes a row nobody owns, and every
 * accepted request gets the same 202 whatever the address's state.
 */
import { NextResponse } from "next/server";

import {
  errorResponse,
  readJsonOnlyBody,
  UnreadableBodyError,
} from "../../../lib/publish/http";
import { clientIp } from "../../../lib/rate-limit";
import { joinWaitlist } from "../../../lib/waitlist/join";

/** `postgres-js` needs TCP sockets, and Resend's SDK is a node client. */
export const runtime = "nodejs";

/** Writes a row and may send mail. Never cacheable. */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonOnlyBody(request);
  } catch (err) {
    if (err instanceof UnreadableBodyError) {
      return errorResponse(400, { error: "invalid_request", message: err.message });
    }
    throw err;
  }

  const outcome = await joinWaitlist(body, clientIp(request));

  if (!outcome.ok) return errorResponse(outcome.status, outcome.body);

  return NextResponse.json(outcome.body, {
    status: outcome.status,
    headers: { "cache-control": "no-store" },
  });
}
