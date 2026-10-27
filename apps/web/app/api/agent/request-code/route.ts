/**
 * `POST /api/agent/request-code { email }` — mail a 6-digit sign-in code an
 * agent trades for an API key (E09 D7). Always 202 `{ ok: true }` past the
 * per-IP limit and the body, whatever the address's state.
 *
 * Any host, open or closed (`CLOSED_API_PATHS`). No session and no origin gate:
 * it reads no cookie and sets none, and it is called from a terminal.
 * The decisions are `lib/agents/code.ts`'s; this is the HTTP boundary.
 */
import { NextResponse } from "next/server";

import { requestAgentCode } from "../../../../lib/agents/code";
import {
  keptClientFrom,
  keyedErrorResponse,
  readJsonOnlyBody,
  UnreadableBodyError,
} from "../../../../lib/publish/http";
import { clientIp } from "../../../../lib/rate-limit";

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
      return keyedErrorResponse(400, { error: "invalid_request", message: err.message });
    }
    throw err;
  }

  const outcome = await requestAgentCode(body, clientIp(request), keptClientFrom(request));
  if (!outcome.ok) return keyedErrorResponse(outcome.status, outcome.body);
  return NextResponse.json(outcome.body, { status: outcome.status, headers: { "cache-control": "no-store" } });
}
