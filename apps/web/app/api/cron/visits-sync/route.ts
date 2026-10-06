/**
 * `POST /api/cron/visits-sync` — read Cloudflare's per-hostname counts into
 * `page_views_daily` (E06 task 009, D8).
 *
 * Called by `.github/workflows/cron-visits-sync.yml` daily, never by a browser.
 * HTTP only: the gate is `lib/cron/authorize.ts`, the work is
 * `lib/visits/sync.ts`. A sibling of `draft-reminder/route.ts`, same shape:
 * guard, run, report counts.
 *
 * `?days=N` (1 to `VISITS_HISTORY_DAYS`, default 1) syncs the N most recent
 * complete UTC days, oldest first — `?days=30` is the first-run backfill. A
 * failure propagates as a 500 after `job_runs.last_error` is recorded, so the
 * scheduled run goes red; the body of a success is counts only.
 */
import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedCronRequest } from "../../../../lib/cron/authorize";
import { completeUtcDays, parseSyncDays, syncVisits } from "../../../../lib/visits/sync";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Writes rows. Never cacheable. */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

/** One fixed body for every rejection, returned BEFORE any database work. */
function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(request)) return unauthorized();

  const days = parseSyncDays(request.nextUrl.searchParams.get("days"));
  if (days === null) {
    return NextResponse.json({ error: "invalid_days" }, { status: 400, headers: NO_STORE });
  }

  const result = await syncVisits(completeUtcDays(days));

  return NextResponse.json({ ok: true, ...result }, { status: 200, headers: NO_STORE });
}
