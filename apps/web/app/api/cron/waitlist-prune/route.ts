/**
 * `POST /api/cron/waitlist-prune` — the daily waitlist prune (E06a §3, AC15).
 *
 * Called by `.github/workflows/cron-waitlist-prune.yml`, never by a browser.
 * Deletes unconfirmed rows 30 days after their last send (never an approved
 * founding creator), legacy 0006 rows that never confirmed, and expired
 * rate-limit buckets. Idempotent: a second run deletes nothing. The answer is
 * counts only.
 */
import { NextResponse } from "next/server";

import { isAuthorizedCronRequest } from "../../../../lib/cron/authorize";
import { pruneWaitlist } from "../../../../lib/db/queries/waitlist";
import { pruneBuckets } from "../../../../lib/rate-limit";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Deletes rows. Never cacheable. */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function POST(request: Request): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const waitlist = await pruneWaitlist();
  const buckets = await pruneBuckets();

  return NextResponse.json(
    { deleted: { waitlist, buckets } },
    { status: 200, headers: NO_STORE },
  );
}
