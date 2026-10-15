/**
 * `POST /api/cron/scan-retry` — finish the scans the first attempt could not
 * (E07 §6.5, §6.12, AC3, AC11, AC22).
 *
 * Called by `.github/workflows/cron-scan-retry.yml` every 12 minutes, never by
 * a browser. HTTP only: the gate is `lib/cron/authorize.ts`, the work is
 * `lib/scan/run.ts` `runScanRetry` (run under `withJobRun("scan-retry", …)`):
 * due `failed` rows, current versions that never got a row, the failure alert
 * and the once-a-day traffic-spike check. Idempotent and batched; the answer is
 * counts only. Pages stay live throughout.
 */
import { NextResponse } from "next/server";

import { isAuthorizedCronRequest } from "../../../../lib/cron/authorize";
import { runScanRetry } from "../../../../lib/scan/run";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Writes rows. Never cacheable. */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function POST(request: Request): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const result = await runScanRetry();

  return NextResponse.json({ ok: true, ...result }, { status: 200, headers: NO_STORE });
}
