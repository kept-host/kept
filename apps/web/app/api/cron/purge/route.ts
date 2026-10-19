/**
 * `POST /api/cron/purge` — hard-delete every page past `purge_after` in a
 * purgeable status, skipping open appeals, and clear old reporter contacts
 * (E07 §6.13, AC24).
 *
 * Called daily by `.github/workflows/cron-purge.yml`, never by a browser. HTTP
 * only: the gate is `lib/cron/authorize.ts`, the work is `lib/lifecycle/purge.ts`
 * (run under `withJobRun("purge", …)`). Batched, deadline-bounded and
 * idempotent; the answer is counts only.
 */
import { NextResponse } from "next/server";

import { isAuthorizedCronRequest } from "../../../../lib/cron/authorize";
import { runPurge } from "../../../../lib/lifecycle/purge";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Deletes stores. Never cacheable. */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function POST(request: Request): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const purged = await runPurge();

  return NextResponse.json({ ok: true, purged }, { status: 200, headers: NO_STORE });
}
