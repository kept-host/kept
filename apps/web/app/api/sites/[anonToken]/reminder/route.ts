/**
 * `POST /api/sites/:anonToken/reminder` — store the "your draft expires soon"
 * address.
 *
 * E04 ONLY PERSISTS IT. The cron that sends anything to it is E05's, and the
 * copy is still an open question on task 008 — so nothing here composes, queues
 * or sends mail, and no mail credential is read.
 *
 * The token is a path segment for the reason written down in
 * `../replace/route.ts`.
 */
import { NextResponse } from "next/server";

import { updateReminderEmail } from "../../../../../lib/publish/anon-manage";
import {
  errorResponse,
  readJsonOnlyBody,
  UnreadableBodyError,
} from "../../../../../lib/publish/http";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Writes a column. Never cacheable. */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ anonToken: string }> },
): Promise<NextResponse> {
  const { anonToken } = await params;

  let body: unknown;
  try {
    body = await readJsonOnlyBody(request);
  } catch (err) {
    if (err instanceof UnreadableBodyError) {
      return errorResponse(400, { error: "invalid_request", message: err.message });
    }
    throw err;
  }

  const outcome = await updateReminderEmail(anonToken, body);

  if (!outcome.ok) return errorResponse(outcome.status, outcome.body);

  return NextResponse.json(outcome.body, {
    status: outcome.status,
    headers: { "cache-control": "no-store" },
  });
}
