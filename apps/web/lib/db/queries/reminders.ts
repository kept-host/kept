/**
 * Every SQL statement the draft-reminder sweep issues — E05 task 011.
 *
 * Same split as `./publish.ts`: the route handler holds HTTP, `lib/email/
 * draft-reminder.ts` holds the ordering and the mail, and this module holds the
 * queries. A change to the due-draft predicate is one edit in one file, and the
 * predicate has to stay in lockstep with the partial index that serves it
 * (`sites_reminder_due_idx` in `../schema.ts`) — keeping both facts in one place
 * is the point.
 *
 * E07 INHERITS THIS SHAPE. Its expiry sweep and grace-end purge want the same
 * thing: select a bounded batch, claim each row with a conditional update, do
 * the side effect, release on failure. Add a sibling module rather than
 * widening this one.
 */
import { and, asc, count, eq, gt, isNull, lte, sql } from "drizzle-orm";

import { db } from "../index";
import { sites } from "../schema";

/**
 * How far ahead of `expires_at` the reminder goes out. T-2d: late enough that
 * the publisher has stopped thinking about the page, early enough that a
 * weekday/weekend gap does not swallow the whole window.
 *
 * NOT in `@kept/shared`: nothing outside the control plane can observe it, and
 * `packages/shared` is for values BOTH apps depend on. The durations the email
 * *quotes* — the 7-day life and the 30-day grace — are shared constants and are
 * read from there, never retyped.
 *
 * A SECOND NUDGE AT T-12H DOES NOT EXIST. It was the epic's open question 3 and
 * the answer was no: it doubles the reminder half of the Resend day budget and
 * doubles the "this is spam" risk for one extra chance to click. Do not add one
 * without the maintainer changing that answer.
 */
export const REMINDER_LEAD_DAYS = 2;

/**
 * THE BUDGET, ENFORCED RATHER THAN DOCUMENTED. Resend's free tier is 3,000 a
 * month and **100 a day**, and the daily ceiling is the binding one because it
 * is shared with magic-link sign-in (`lib/auth/index.ts`) — one account, one
 * bucket, two consumers.
 *
 * The agreed split is **40 to this sweep, ~60 held for sign-in**. 60 sign-in
 * emails a day is a comfortable multiple of what a pre-launch product uses,
 * and 40 reminders is a full day's worth of expiring drafts at a publish rate
 * this product has never seen. A magic link that silently fails to send is
 * indistinguishable from a broken product, so when the two collide the reminder
 * is the one that must lose.
 *
 * This is the `LIMIT` on the selection below, so the cap is enforced by
 * Postgres and cannot be lost in a caller. Overflow is not dropped silently:
 * the sweep reports `skippedForCap`, and the ordering (nearest expiry first)
 * means the drafts that lose are the ones with the most time left.
 */
export const REMINDER_RUN_CAP = 40;

/** A draft due for its one reminder. Deliberately no token and no owner. */
export interface DueReminder {
  id: string;
  slug: string;
  reminderEmail: string;
  expiresAt: Date;
}

/**
 * The due-draft predicate, in one place because two callers need it identical:
 * the count that reports `skippedForCap` and the capped select that sends.
 *
 * - `ownerId IS NULL` — anonymous only. An owned draft's owner has a dashboard
 *   and a sign-in; emailing them a bearer link would be strictly worse.
 * - `status = 'live'` — a quarantined, archived or already-expired page is not
 *   something to nudge anybody about.
 * - `reminderEmail IS NOT NULL` — the publisher opted in, on the result screen.
 * - `reminderSentAt IS NULL` — one reminder, ever.
 * - `expiresAt` in `(now, now + REMINDER_LEAD_DAYS]` — ahead of us, inside the
 *   window. The strict lower bound matters: a draft already past its clock is
 *   E07's problem, not a reminder.
 */
function dueDraftWhere(now: Date) {
  const horizon = new Date(now.getTime() + REMINDER_LEAD_DAYS * 24 * 60 * 60 * 1000);
  return and(
    isNull(sites.ownerId),
    eq(sites.status, "live"),
    sql`${sites.reminderEmail} is not null`,
    isNull(sites.reminderSentAt),
    gt(sites.expiresAt, now),
    lte(sites.expiresAt, horizon),
  );
}

/** How many drafts are due right now, cap or no cap. Drives `skippedForCap`. */
export async function countDueReminders(now: Date): Promise<number> {
  const [row] = await db.select({ n: count() }).from(sites).where(dueDraftWhere(now));
  return row?.n ?? 0;
}

/**
 * The batch, nearest expiry first and hard-capped.
 *
 * The ordering is not cosmetic: it is what makes the cap survivable. If 200
 * drafts are due and 40 can be mailed, the 40 chosen are the ones closest to
 * coming down, and the rest are still inside the window tomorrow.
 */
export async function selectDueReminders(
  now: Date,
  limit: number = REMINDER_RUN_CAP,
): Promise<DueReminder[]> {
  const rows = await db
    .select({
      id: sites.id,
      slug: sites.slug,
      reminderEmail: sites.reminderEmail,
      expiresAt: sites.expiresAt,
    })
    .from(sites)
    .where(dueDraftWhere(now))
    .orderBy(asc(sites.expiresAt))
    .limit(limit);

  // The predicate guarantees both are set; the column types do not.
  return rows.flatMap((row) =>
    row.reminderEmail && row.expiresAt
      ? [{ ...row, reminderEmail: row.reminderEmail, expiresAt: row.expiresAt }]
      : [],
  );
}

/**
 * CLAIM THE ROW BEFORE SENDING, and claim it conditionally.
 *
 * `where reminder_sent_at is null` is the whole idempotency story: two
 * overlapping runs, or one run replayed by a retried webhook, both issue this
 * update and exactly one of them gets a row back. The loser sends nothing. It
 * is also why a crash between here and the send cannot double-send — the row is
 * already stamped, so the next run does not select it.
 *
 * The keep-token digest is written in the SAME statement, so a stamped row
 * always has a resolvable link and a link never outlives its stamp.
 *
 * `updated_at` is deliberately NOT bumped: this is delivery bookkeeping, not a
 * change to the page, and `updated_at` is what the KV manifest reports about
 * the content.
 */
export async function claimReminder(
  siteId: string,
  sentAt: Date,
  keepTokenHash: string,
): Promise<boolean> {
  const claimed = await db
    .update(sites)
    .set({ reminderSentAt: sentAt, reminderKeepTokenHash: keepTokenHash })
    .where(and(eq(sites.id, siteId), isNull(sites.reminderSentAt)))
    .returning({ id: sites.id });
  return claimed.length === 1;
}

/**
 * Undo a claim whose send failed, so the next run retries it.
 *
 * The minted token is dropped with the stamp: it was never delivered, so
 * leaving a live credential behind would be a bearer token nobody holds and
 * nobody can revoke.
 */
export async function releaseReminder(siteId: string): Promise<void> {
  await db
    .update(sites)
    .set({ reminderSentAt: null, reminderKeepTokenHash: null })
    .where(eq(sites.id, siteId));
}

/**
 * Unsubscribe: forget the address and revoke the emailed link, in one write.
 *
 * Clearing `reminder_email` is exactly what E04's result screen already treats
 * as a valid save, so this adds no new state — it is the same "no address on
 * file" the publisher could have chosen there. `reminder_sent_at` is left
 * stamped: unsubscribing must not make the page eligible again.
 *
 * Returns false when the token matches nothing, so the caller can answer
 * identically either way rather than confirming a page exists.
 */
export async function clearReminderByKeepTokenHash(hash: string): Promise<boolean> {
  const cleared = await db
    .update(sites)
    .set({ reminderEmail: null, reminderKeepTokenHash: null })
    .where(eq(sites.reminderKeepTokenHash, hash))
    .returning({ id: sites.id });
  return cleared.length === 1;
}

/**
 * Map a reminder keep token's digest onto the page's ANON token digest.
 *
 * This exists so `lib/publish/anon-token.ts` can resolve the emailed token
 * through `findSiteByAnonTokenHash` — the one resolver — instead of growing a
 * parallel lookup that would eventually get the 404 shape or the status guard
 * subtly different. Null once the page has been kept (`anon_token_hash` is
 * cleared then), which is correct: after keeping, the account is the authority
 * and the emailed link must stop working.
 */
export async function findAnonTokenHashByReminderKeepTokenHash(
  hash: string,
): Promise<string | null> {
  const [row] = await db
    .select({ anonTokenHash: sites.anonTokenHash })
    .from(sites)
    .where(eq(sites.reminderKeepTokenHash, hash))
    .limit(1);
  return row?.anonTokenHash ?? null;
}
