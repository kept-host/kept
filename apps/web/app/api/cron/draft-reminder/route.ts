/**
 * `POST /api/cron/draft-reminder` — send the one pre-expiry reminder.
 *
 * Called by the scheduled GitHub Actions workflow
 * (`.github/workflows/cron-draft-reminder.yml`), never by a browser. HTTP only:
 * the gate is `lib/cron/authorize.ts`, the work is
 * `lib/email/draft-reminder.ts`, the SQL is `lib/db/queries/reminders.ts`.
 *
 * POST rather than GET because it has effects — and because a GET would be
 * followed by every link prefetcher and security scanner that ever saw the URL.
 *
 * E07 ADDS A SIBLING HERE. The expiry sweep and the grace-end purge are the
 * same shape: guard, run, report counts. Copy this file, not the guard.
 */
import { NextResponse } from "next/server";

import { isAuthorizedCronRequest } from "../../../../lib/cron/authorize";
import { runDraftReminderSweep } from "../../../../lib/email/draft-reminder";

/** `postgres-js` needs TCP sockets, and Resend's SDK is a node client. */
export const runtime = "nodejs";

/** Sends mail and writes columns. Never cacheable. */
export const dynamic = "force-dynamic";

/**
 * One fixed body for every rejection, returned BEFORE any database work.
 * It states nothing about the endpoint, the batch, or whether a secret was
 * close — a caller without the secret learns only that the secret is required.
 */
function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: "unauthorized" },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(request)) return unauthorized();

  const result = await runDraftReminderSweep();

  return NextResponse.json(
    { ok: true, ...result },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
