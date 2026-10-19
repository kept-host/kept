/**
 * `POST /api/cron/repurge` — replay the edge purges and manifest syncs that are
 * still owed (E07 §6.14, AC35).
 *
 * Called by `.github/workflows/cron-repurge.yml` every 10–15 minutes, never by
 * a browser. HTTP only: the gate is `lib/cron/authorize.ts`, the work is
 * `lib/storage/repurge.ts` (run under `withJobRun("repurge", …)`). Idempotent
 * and batched; the answer is counts only.
 */
import { NextResponse } from "next/server";

import { isAuthorizedCronRequest } from "../../../../lib/cron/authorize";
import { replayDuePurges } from "../../../../lib/storage/repurge";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Writes stores. Never cacheable. */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function POST(request: Request): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const replayed = await replayDuePurges();

  return NextResponse.json({ ok: true, replayed }, { status: 200, headers: NO_STORE });
}
