/**
 * `POST /api/agent/verify-code { email, code, keyName }` — trade an emailed
 * code for a new API key, shown in this response and never again (E09 D7).
 * Creates the account through Better Auth when the address has none.
 *
 * Any host, open or closed (`CLOSED_API_PATHS`). No session and no origin gate:
 * the code is the authority, no cookie is read or set, and it is called from a
 * terminal. The decisions are `lib/agents/code.ts`'s; this is the HTTP boundary.
 */
import { NextResponse } from "next/server";

import { verifyAgentCode } from "../../../../lib/agents/code";
import { keyedErrorResponse, readJsonOnlyBody, UnreadableBodyError } from "../../../../lib/publish/http";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Mints a key. Never cacheable. */
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

  const outcome = await verifyAgentCode(body);
  if (!outcome.ok) return keyedErrorResponse(outcome.status, outcome.body);
  return NextResponse.json(outcome.body, { status: outcome.status, headers: { "cache-control": "no-store" } });
}
