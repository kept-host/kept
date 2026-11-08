/**
 * `GET /api/referrals` — the signed-in account's referral stats (E10 D11, PRD
 * §5.6, AC18): what its link carries, the verified sign-up count, and each
 * verified sign-up as a date and a display name. Never an email.
 */
import type { NextResponse } from "next/server";

import { getSession } from "../../../lib/auth/session";
import { getProfileForSession } from "../../../lib/db/queries/profile";
import { referralStatsFor } from "../../../lib/referrals/stats";
import { ownerResponse, signedOut } from "../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Per-account and session-shaped. */
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const profile = await getProfileForSession(await getSession());
  if (!profile) return ownerResponse(signedOut());
  return ownerResponse({ ok: true, status: 200, body: await referralStatsFor(profile) });
}
