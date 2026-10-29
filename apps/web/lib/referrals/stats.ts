/**
 * `GET /api/referrals` and the `/referrals` screen (E10 D11, PRD §5.6, AC18) —
 * one read for both. Verified sign-ups only, each a date and a display name;
 * never an email.
 */
import { referralStatsSchema, type ReferralStats } from "@kept/shared";

import { referralStats } from "../db/queries/referrals";

/** What the link carries for an account: the current handle, else the permanent code (Q3). */
export function refCodeOf(profile: { handle: string | null; referralCode: string }): string {
  return profile.handle ?? profile.referralCode;
}

export async function referralStatsFor(profile: {
  id: string;
  handle: string | null;
  referralCode: string;
}): Promise<ReferralStats> {
  const stats = await referralStats(profile.id);
  return referralStatsSchema.parse({
    refCode: refCodeOf(profile),
    verifiedCount: stats.verifiedCount,
    referrals: stats.referrals.map((row) => ({
      createdAt: row.createdAt.toISOString(),
      displayName: row.displayName,
    })),
  });
}
