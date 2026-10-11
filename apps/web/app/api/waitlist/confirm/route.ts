/**
 * `POST /api/waitlist/confirm` — `{ token }` → 200 `{ status: "confirmed" }`,
 * or 410 for an unknown, used or expired token (E06a §3, AC10). The button on
 * `/waitlist/confirm` is its only caller; a GET never confirms (D1).
 *
 * Unauthenticated: the token is the authority, and only its digest is stored.
 */
import { NextResponse } from "next/server";

import { readJsonOnlyBody, UnreadableBodyError } from "../../../../lib/publish/http";
import { confirmWaitlist } from "../../../../lib/waitlist/confirm";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Writes a row. Never cacheable. */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown = null;
  try {
    body = await readJsonOnlyBody(request);
  } catch (err) {
    if (!(err instanceof UnreadableBodyError)) throw err;
  }

  const confirmed = await confirmWaitlist(body);
  return confirmed
    ? NextResponse.json({ status: "confirmed" }, { status: 200, headers: NO_STORE })
    : NextResponse.json(
        { error: "expired", message: "This link has expired or was already used." },
        { status: 410, headers: NO_STORE },
      );
}
