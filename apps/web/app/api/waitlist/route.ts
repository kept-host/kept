/**
 * `POST /api/waitlist` — `{ email }` onto the waitlist.
 *
 * One of the two route handlers a closed deploy keeps (`decideClosedAction` in
 * `lib/routing/host-split.ts`); it answers on an open one too, it just has no
 * caller there. No session and no origin gate: it writes nothing that belongs
 * to anyone, and a second join of the same address is a no-op.
 */
import { NextResponse } from "next/server";

import {
  errorResponse,
  readJsonOnlyBody,
  UnreadableBodyError,
} from "../../../lib/publish/http";
import { joinWaitlist } from "../../../lib/waitlist/join";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Writes a row. Never cacheable. */
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

  const outcome = await joinWaitlist(body);

  if (!outcome.ok) return errorResponse(outcome.status, outcome.body);

  return NextResponse.json(outcome.body, {
    status: outcome.status,
    headers: { "cache-control": "no-store" },
  });
}
