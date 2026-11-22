/**
 * Every SQL statement about referrals (E10 D11) — the only module that reads or
 * writes `referrals`.
 *
 * A referral counts once `verified_at` is set; an unverified sign-up never does
 * (edge case 10). Stats carry a date and a display name, never an email.
 */
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";

import { db } from "../index";
import { referrals, user } from "../schema";

/**
 * Credit `referrerId` with the new account `referredId`. Returns whether a row
 * was written: `false` for a self-referral (also a CHECK) and for an account
 * already referred (the primary key — the first referral wins).
 */
export async function insertReferral(input: {
  referrerId: string;
  referredId: string;
  /** The referred account's email is already verified (magic link, verified OAuth). */
  verified: boolean;
}): Promise<boolean> {
  if (input.referrerId === input.referredId) return false;
  const inserted = await db
    .insert(referrals)
    .values({
      referrerId: input.referrerId,
      referredId: input.referredId,
      verifiedAt: input.verified ? new Date() : null,
    })
    .onConflictDoNothing({ target: referrals.referredId })
    .returning({ referredId: referrals.referredId });
  return inserted.length > 0;
}

/** Stamp the referred account's referral verified; a no-op if already stamped or absent. */
export async function markReferralVerified(referredId: string): Promise<void> {
  await db
    .update(referrals)
    .set({ verifiedAt: new Date() })
    .where(and(eq(referrals.referredId, referredId), isNull(referrals.verifiedAt)));
}

/** A referrer's verified sign-ups, newest first: when, and the display name only. */
export async function referralStats(referrerId: string): Promise<{
  verifiedCount: number;
  referrals: { createdAt: Date; displayName: string | null }[];
}> {
  const rows = await db
    .select({ createdAt: referrals.createdAt, displayName: user.name })
    .from(referrals)
    .innerJoin(user, eq(user.id, referrals.referredId))
    .where(and(eq(referrals.referrerId, referrerId), isNotNull(referrals.verifiedAt)))
    .orderBy(desc(referrals.createdAt));
  return {
    verifiedCount: rows.length,
    referrals: rows.map((row) => ({
      createdAt: row.createdAt,
      displayName: row.displayName.trim() || null,
    })),
  };
}
