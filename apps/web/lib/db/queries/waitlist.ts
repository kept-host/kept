/**
 * The waitlist's SQL (E06a §3). `lib/waitlist/*` owns validation, limits, mail
 * and the answer; this module owns the statements. Every clock is the
 * database's `now()`, and every "day" is the UTC day.
 */
import {
  WAITLIST_CONFIRM_TTL_DAYS,
  WAITLIST_MAX_SENDS_PER_DAY,
  WAITLIST_PRUNE_DAYS,
  WAITLIST_RESEND_COOLDOWN_MINUTES,
  type FoundingStatus,
  type WaitlistSource,
} from "@kept/shared";
import { sql, type SQL } from "drizzle-orm";

import { db } from "../index";

/** The UTC calendar day of a timestamptz expression. */
const utcDay = (expression: SQL) => sql`(${expression} at time zone 'UTC')::date`;

/**
 * The join state machine, as ONE atomic upsert. Returns `true` when the caller
 * must send a confirmation mail carrying the token whose digest is `tokenHash`;
 * `false` when nothing changed.
 *
 *   no row                         → insert pending, send
 *   unsubscribed (any)             → fresh token, clear unsubscribed_at and
 *                                    confirmed_at (double opt-in again), send
 *   legacy 0006 row, unconfirmed   → fresh token, send
 *   confirmed                      → nothing
 *   pending, never sent (admin)    → fresh token, send
 *   pending, sent < 10 min ago     → nothing
 *   pending, 3 sends today (UTC)   → nothing
 *   pending otherwise              → fresh token, send
 *
 * `confirm_send_count` counts sends on the UTC day of `confirm_sent_at` and
 * restarts at 1 on a new day. A resend replaces the token, so only the newest
 * mail's link confirms. Founding columns are not touched here: an application
 * is recorded first, by `upsertFoundingApplication` (`queries/founding.ts`).
 */
export async function upsertWaitlistJoin(input: {
  email: string;
  source: WaitlistSource;
  tokenHash: string;
}): Promise<boolean> {
  const sameDay = sql`${utcDay(sql`waitlist.confirm_sent_at`)} = ${utcDay(sql`now()`)}`;
  const rows = await db.execute(sql`
    insert into waitlist (email, source, confirm_token_hash, confirm_sent_at, confirm_send_count)
    values (${input.email}, ${input.source}, ${input.tokenHash}, now(), 1)
    on conflict (email) do update set
      source = excluded.source,
      confirm_token_hash = excluded.confirm_token_hash,
      confirm_sent_at = now(),
      confirm_send_count = case
        when waitlist.confirm_sent_at is not null and ${sameDay}
          then waitlist.confirm_send_count + 1
        else 1
      end,
      confirmed_at = null,
      unsubscribed_at = null
    where waitlist.unsubscribed_at is not null
      or (
        waitlist.confirmed_at is null
        and (
          waitlist.source = 'legacy'
          or waitlist.confirm_sent_at is null
          or (
            waitlist.confirm_sent_at <= now() - make_interval(mins => ${WAITLIST_RESEND_COOLDOWN_MINUTES})
            and (not (${sameDay}) or waitlist.confirm_send_count < ${WAITLIST_MAX_SENDS_PER_DAY})
          )
        )
      )
    returning 1
  `);
  return rows.length > 0;
}

/** What a confirmation changed: the address and its founding application, if any. */
export interface ConfirmedRow {
  email: string;
  foundingStatus: FoundingStatus | null;
  socialUrl: string | null;
  note: string | null;
}

/**
 * Confirm the row whose live token digest is `tokenHash`: set `confirmed_at`
 * and clear the digest, so the link works once. `null` for an unknown, used or
 * expired (older than `WAITLIST_CONFIRM_TTL_DAYS` since it was sent) token.
 */
export async function confirmWaitlistByTokenHash(tokenHash: string): Promise<ConfirmedRow | null> {
  const rows = await db.execute<{
    email: string;
    founding_status: FoundingStatus | null;
    social_url: string | null;
    note: string | null;
  }>(sql`
    update waitlist
    set confirmed_at = now(), confirm_token_hash = null
    where confirm_token_hash = ${tokenHash}
      and confirm_sent_at > now() - make_interval(days => ${WAITLIST_CONFIRM_TTL_DAYS})
    returning email, founding_status, social_url, note
  `);
  const row = rows[0];
  return row
    ? {
        email: row.email,
        foundingStatus: row.founding_status,
        socialUrl: row.social_url,
        note: row.note,
      }
    : null;
}

/**
 * Unsubscribe an address: stamp `unsubscribed_at` (the first time only) and
 * kill any pending confirmation link. The row stays, so the address stays
 * suppressed; an absent address is a no-op.
 */
export async function unsubscribeWaitlistEmail(email: string): Promise<void> {
  await db.execute(sql`
    update waitlist
    set unsubscribed_at = coalesce(unsubscribed_at, now()), confirm_token_hash = null
    where email = ${email}
  `);
}

/**
 * The prune (AC15): unconfirmed rows `WAITLIST_PRUNE_DAYS` after their last
 * confirmation mail, and legacy 0006 rows that never confirmed — never an
 * approved founding creator. Returns how many rows went.
 */
export async function pruneWaitlist(): Promise<number> {
  const rows = await db.execute(sql`
    delete from waitlist
    where confirmed_at is null
      and founding_status is distinct from 'approved'
      and (
        source = 'legacy'
        or confirm_sent_at < now() - make_interval(days => ${WAITLIST_PRUNE_DAYS})
      )
    returning 1
  `);
  return rows.length;
}
