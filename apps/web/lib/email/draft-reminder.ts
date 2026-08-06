/**
 * The draft-reminder sweep — E05 task 011.
 *
 * E04 collects `sites.reminder_email` on the result screen and stops there; its
 * confirmation copy says the address is "stored with this page" and pointedly
 * does not claim anything is scheduled, because nothing was. This module is
 * what makes it true: select the drafts due at T-2d, claim each one, send one
 * email, release the claim if the send fails.
 *
 * ORDERING, AND WHY IT IS THIS WAY ROUND:
 *
 *   count due  ──▶  select capped batch  ──▶  per row: claim ─▶ send ─▶ (release on failure)
 *
 * The claim precedes the send. A crash between the two loses one reminder; a
 * send before the claim would, on the same crash, send the reminder twice —
 * and a duplicate is the failure the publisher actually notices. The release
 * path exists so an ordinary Resend refusal (a bounce, a rate limit) still
 * retries tomorrow instead of burning the single reminder.
 *
 * ONE SEND PER ROW, ONE ROW AT A TIME. Not `Promise.all`: the point of the cap
 * is to stay inside a shared rate budget, and forty simultaneous requests is
 * the shape most likely to trip Resend's own limiter and fail the whole batch.
 *
 * NOTHING HERE LOGS AN ADDRESS OR A TOKEN. Failures name the slug and the site
 * id, which are enough to diagnose anything and grant nothing — the same rule
 * `lib/publish/anon-token.ts` sets for the publisher's own token.
 */
import {
  DRAFT_GRACE_DAYS,
  DRAFT_TTL_DAYS,
  generateAnonToken,
  hashToken,
  KEPT_PAGE_LIMIT,
} from "@kept/shared";
import { Resend } from "resend";

import {
  claimReminder,
  countDueReminders,
  releaseReminder,
  REMINDER_RUN_CAP,
  selectDueReminders,
  type DueReminder,
} from "../db/queries/reminders";
import { appOrigin, resendConfig, servingBaseDomain } from "../storage/env";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** What a run reports. Counts only — never an address, never a token. */
export interface DraftReminderSweepResult {
  /** Drafts matching the due predicate, before the cap. */
  selected: number;
  /** Emails Resend accepted. */
  sent: number;
  /** Rows claimed, refused by Resend, and released for a retry. */
  failed: number;
  /** Due drafts left for the next run because `REMINDER_RUN_CAP` bit. */
  skippedForCap: number;
  /** Rows another run (or a replay of this one) had already claimed. */
  skippedAlreadyClaimed: number;
}

/** The composed message. Exported so its copy is testable without a send. */
export interface DraftReminderEmail {
  subject: string;
  text: string;
  headers: Record<string, string>;
}

function formatUtcDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(date);
}

function pluralDays(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

/**
 * The reminder itself.
 *
 * ⚠️ THE KEEP LINK IS A BEARER CREDENTIAL IN AN EMAIL, AND THAT IS THE TRADE.
 * Whoever holds it can keep, replace or delete this page with no other
 * authentication. It is sent anyway because the alternative is an email that
 * cannot act — the address was volunteered by the publisher *specifically* to
 * receive this link, and for an anonymous page a token is the only handle that
 * exists. What limits the exposure: the token is minted per reminder and is not
 * the publisher's own (see `sites.reminder_keep_token_hash`), only its digest
 * is stored, it dies when the page is kept, unsubscribing revokes it, and
 * `/keep/[anonToken]` is already `noindex`. It is never logged.
 *
 * EVERY DURATION IS COMPOSED, NEVER TYPED. The 7-day life and the 30-day grace
 * come from `@kept/shared`; the days-left figure is derived from the row's own
 * clock. A literal `7` in this copy is exactly the drift E04's constants rule
 * was written to stop.
 */
export function buildDraftReminderEmail(input: {
  slug: string;
  expiresAt: Date;
  now: Date;
  keepUrl: string;
  unsubscribeUrl: string;
  liveUrl: string;
}): DraftReminderEmail {
  const daysLeft = Math.max(
    1,
    Math.round((input.expiresAt.getTime() - input.now.getTime()) / MS_PER_DAY),
  );

  return {
    subject: `Your kept draft expires in ${pluralDays(daysLeft)}`,
    text:
      `Your page is live at ${input.liveUrl}\n\n` +
      `It went up as a draft, so it stays online for ${pluralDays(DRAFT_TTL_DAYS)} ` +
      `and then comes down on ${formatUtcDate(input.expiresAt)} — unless you keep it.\n\n` +
      `Keep it forever (free, up to ${KEPT_PAGE_LIMIT} pages):\n${input.keepUrl}\n\n` +
      `That link manages this page, so treat it like a password — anyone who has ` +
      `it can replace or delete the page.\n\n` +
      `If the draft does come down we hold on to it for another ` +
      `${pluralDays(DRAFT_GRACE_DAYS)}, so you can still keep it after the fact.\n\n` +
      `Don't want reminders about this page? ${input.unsubscribeUrl}\n`,
    headers: {
      // RFC 8058 one-click. Mail clients POST the URL themselves, so the
      // publisher never has to trust a link in an email to stop the email.
      "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/**
 * Where the emailed one-time token is redeemed: E04's existing keep screen,
 * built from the CONTROL PLANE's origin. Never `KEPT_BASE_DOMAIN` — that is the
 * serving domain, it is 100% Cloudflare, and it has no auth surface at all.
 */
function keepUrl(origin: string, token: string): string {
  return `${origin}/keep/${token}`;
}

function unsubscribeUrl(origin: string, token: string): string {
  return `${origin}/unsubscribe/${token}`;
}

/**
 * Run one sweep. Safe to invoke twice: the second run sends zero emails,
 * because every row the first run touched is stamped and no longer selected.
 */
export async function runDraftReminderSweep(
  now: Date = new Date(),
): Promise<DraftReminderSweepResult> {
  const due = await countDueReminders(now);
  const batch = await selectDueReminders(now, REMINDER_RUN_CAP);

  const result: DraftReminderSweepResult = {
    selected: due,
    sent: 0,
    failed: 0,
    skippedForCap: Math.max(0, due - batch.length),
    skippedAlreadyClaimed: 0,
  };

  if (batch.length === 0) return result;

  // Constructed once per run, and only once there is something to send, so a
  // sweep on an empty window costs no credential read. `resendConfig()` is the
  // ONE accessor for the shared 100/day budget — `RESEND_API_KEY` is never read
  // directly here. (`lib/auth/index.ts` keeps its own instance private to the
  // magic-link plugin; there is no exported client to reuse, and reaching into
  // that module to make one would couple mail delivery to auth configuration.)
  const { apiKey, from } = resendConfig();
  const mailer = new Resend(apiKey);
  const origin = appOrigin();
  const baseDomain = servingBaseDomain();

  for (const draft of batch) {
    await sendOne(mailer, from, origin, baseDomain, draft, now, result);
  }

  return result;
}

async function sendOne(
  mailer: Resend,
  from: string,
  origin: string,
  baseDomain: string,
  draft: DueReminder,
  now: Date,
  result: DraftReminderSweepResult,
): Promise<void> {
  const token = generateAnonToken();
  const claimed = await claimReminder(draft.id, now, await hashToken(token));
  if (!claimed) {
    // Another run beat us to it between the select and here. Not an error —
    // this is the concurrency guard doing its job.
    result.skippedAlreadyClaimed += 1;
    return;
  }

  const message = buildDraftReminderEmail({
    slug: draft.slug,
    expiresAt: draft.expiresAt,
    now,
    keepUrl: keepUrl(origin, token),
    unsubscribeUrl: unsubscribeUrl(origin, token),
    liveUrl: `https://${draft.slug}.${baseDomain}`,
  });

  try {
    const { error } = await mailer.emails.send({
      from,
      to: draft.reminderEmail,
      subject: message.subject,
      text: message.text,
      headers: message.headers,
    });
    if (error) throw new Error(`${error.name} — ${error.message}`);
    result.sent += 1;
  } catch (err) {
    // ONE FAILURE DOES NOT ABORT THE BATCH. Release the claim so the next run
    // retries this row, count it, and carry on with the rest.
    await releaseReminder(draft.id);
    result.failed += 1;
    console.error(
      `[kept] draft-reminder: send failed for site ${draft.id} (slug "${draft.slug}") — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
