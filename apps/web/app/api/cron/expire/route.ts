/**
 * `POST /api/cron/expire` — turn every `live` draft past its clock into
 * `expired`, so the edge serves "This draft wasn't kept" (E07 §6.13, AC23).
 *
 * Called hourly by `.github/workflows/cron-expire.yml`, never by a browser. HTTP
 * only: the gate is `lib/cron/authorize.ts`, the work is `lib/lifecycle/expire.ts`
 * (run under `withJobRun("expire", …)`). Batched, deadline-bounded and
 * idempotent; the answer is counts only.
 */
import { NextResponse } from "next/server";

import { isAuthorizedCronRequest } from "../../../../lib/cron/authorize";
import { runExpire } from "../../../../lib/lifecycle/expire";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Writes stores. Never cacheable. */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function POST(request: Request): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const expired = await runExpire();

  return NextResponse.json({ ok: true, expired }, { status: 200, headers: NO_STORE });
}
