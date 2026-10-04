/**
 * How an owned page is *presented* — E06 task 003.
 *
 * Pure functions, no database, no React. They live in `lib/` rather than beside
 * the card because they encode rules that outlive one screen and because
 * `lib/**` is what the unit suite globs — a rule that only exists inside a
 * `.tsx` under `app/` is a rule nothing can assert.
 *
 * ⚠️ THE ONE THAT MATTERS IS `effectiveStatus`. Everything else here is
 * formatting.
 */
import { DRAFT_TTL_DAYS, type SiteStatus } from "@kept/shared";

/**
 * What to call a page. `title ?? slug`, in one place — E06 task 007.
 *
 * The rule is stated in three docs and was, until the swap chooser, written out
 * at every call site. It is one `??`, and that is exactly why it drifts: the
 * card, the chooser and the confirmation sentence naming the SAME page by two
 * different rules is how somebody ends up reading "k3n8vq2p becomes a draft"
 * about a page the wall calls "Recipe notes".
 */
export function pageName(site: { title: string | null; slug: string }): string {
  return site.title ?? site.slug;
}

/**
 * The status a card may actually claim, given what the clock says.
 *
 * A draft that has crossed `expires_at` while nobody has swept it is **still**
 * `status = 'live'` in Postgres — E07 owns that flip, and until its sweep runs
 * the row is stale by design, not by accident. A card that prints `status`
 * verbatim will confidently tell somebody an expired page is live, which is the
 * one thing the dashboard must never do: the whole product is a promise about
 * whether a link still works.
 *
 * So the clock wins, and only in the one direction that is safe. `live` is
 * downgraded to `expired`; `quarantined`, `under_review`, `archived` and
 * `removed` are passed through untouched, because they are states E07 *wrote*
 * and no clock in this process is entitled to overrule them.
 */
export function effectiveStatus(
  status: SiteStatus,
  expiredByClock: boolean,
): SiteStatus {
  return expiredByClock && status === "live" ? "expired" : status;
}

/**
 * Why a page's management verbs are unavailable, or `null` when they are not.
 *
 * REFUSE WITH A REASON, NEVER HIDE. A page that quietly loses its controls when
 * it is flagged is indistinguishable from data loss, and the owner's next move
 * is a support email asking where their page went. Exported so the surfaces that
 * own those verbs — the swap chooser (task 007), the card actions (task 009),
 * the detail screen (task 008) — all *disable and explain* from one sentence
 * rather than each inventing its own or, worse, dropping the button.
 *
 * E06 renders these states and writes none of them; E07 owns every flip.
 *
 * Download is deliberately not promised here, even though task 008's detail
 * screen now offers one. That control is bounded by `PREVIEW_MAX_BYTES` — it
 * hands back the bytes the screen already read — so it is not always on screen,
 * and a shared sentence that promised it would be the interface lying about a
 * button that is not there. The screen that *has* the button says so itself.
 */
export function managementRefusal(status: SiteStatus): string | null {
  switch (status) {
    case "quarantined":
      return "This page is under review and is not being served. Renaming, replacing and keeping are on hold until the review finishes. Deleting still works.";
    case "under_review":
      return "This page is being reviewed. It stays at its link in the meantime, but renaming, replacing and keeping are on hold until the review finishes. Deleting still works.";
    default:
      return null;
  }
}

/** Whether the verbs above are refused. The predicate behind the sentence. */
export function isManagementRestricted(status: SiteStatus): boolean {
  return managementRefusal(status) !== null;
}

/**
 * Why a page cannot be the one swapped out, or `null` when it can — E06 task 007.
 *
 * TWO REASONS, AND THE SECOND IS THE ONE THE CHOOSER WOULD OTHERWISE GET WRONG.
 * The first is the standing restriction above. The second is arithmetic: the cap
 * counts `expires_at IS NULL AND status = 'live'` (`isKeptCondition`), so a page
 * that is clockless but *not* `live` — archived, expired, removed, or held under
 * review — is already outside the count. Demoting it frees nothing, and the swap
 * would end with the account still at its kept limit and one more draft than
 * it started with. Offering it would be offering a no-op that costs the user a
 * permanent page.
 *
 * The wall groups by the clock alone, so those rows sit under "Kept" and are the
 * obvious thing to pick. They are listed and REFUSED rather than dropped, for
 * `managementRefusal`'s reason: a control that silently disappears is
 * indistinguishable from a page that did.
 */
export function swapRefusal(status: SiteStatus): string | null {
  const restricted = managementRefusal(status);
  if (restricted) return restricted;
  if (status !== "live") {
    return "This page is not being served, so swapping it out would not free a kept slot.";
  }
  return null;
}

/**
 * The sentence the swap chooser must say before it writes anything — task 007.
 *
 * ⚠️ BOTH PAGES ARE NAMED, AND THE NUMBER IS NEVER TYPED. "Swap a page?" is not
 * a warning; it is a shrug with a confirm button. The user is choosing which of
 * their permanent pages stops being permanent, and the only way that choice can
 * be made with the consequence in view is for the consequence to name the page
 * losing it, the page gaining it, and how long the loser now has.
 *
 * `DRAFT_TTL_DAYS` is substituted for the reason `draft-chip.tsx` carries no
 * `7`: demote sets a FRESH clock — not the remainder of some earlier one — and
 * the day that constant moves, a typed number turns this sentence into a lie
 * told at the exact moment somebody is trusting it.
 *
 * It lives here rather than in the dialog because `lib/**` is what the unit
 * suite globs, and a copy rule that cannot be asserted is a copy rule that will
 * be edited back to a literal.
 */
export function swapConsequence(demoteName: string, keepName: string): string {
  return `${demoteName} becomes a draft again and expires in ${DRAFT_TTL_DAYS} days. ${keepName} is kept for good. Nothing is deleted and both pages stay at their links.`;
}

/**
 * The sentence a plain demote must say BEFORE it writes — E06 task 008.
 *
 * ⚠️ SHOWN BEFORE THE CALL, NEVER AFTER IT. Demote is the one verb on the detail
 * screen that takes something away — a permanent page stops being permanent —
 * and the endpoint deliberately does no confirming of its own
 * (`app/api/sites/[id]/demote/route.ts`: "the confirmation is the caller's").
 * A warning printed after the write is not a warning, it is a receipt.
 *
 * It is a sibling of `swapConsequence` rather than a call into it: a swap trades
 * one page for another and names both, a demote gives a slot back and names one.
 * Reusing the swap sentence would mean inventing a second page to put in it.
 *
 * `DRAFT_TTL_DAYS` is substituted for the same reason it is there — demote sets
 * a FRESH clock, and a typed number turns this into a lie the day the cap moves.
 */
export function demoteConsequence(name: string): string {
  return `${name} becomes a draft again and expires in ${DRAFT_TTL_DAYS} days. Nothing is deleted, the page stays at the same link, and you can keep it again while a slot is free.`;
}

/**
 * What a signed-in publish that landed *kept* says — E06 task 009.
 *
 * Short on purpose. Nothing was traded, nothing has a deadline, and the card
 * that appears on the wall a moment later says the rest. The only fact worth
 * spending a sentence on is the one the product is actually selling: the link
 * works now and will keep working.
 */
export function publishedKeptNotice(name: string): string {
  return `${name} is live at its link and kept for good.`;
}

/**
 * What a signed-in publish that landed *at the cap* says — E06 task 009.
 *
 * ⚠️ THIS IS A SUCCESS SENTENCE AND IT MUST NOT READ LIKE A REJECTION. The route
 * answers HTTP 200 (`outcome: "owned_draft"`, epic D1): the page was published,
 * it is serving right now, the account owns it, and the only difference is that
 * it carries a clock. Copy that opens with what went wrong contradicts the
 * locked decision that the cap degrades rather than errors — which is the whole
 * reason this branch exists instead of a 4xx.
 *
 * It states the consequence and stops. The route out — swap, or Pro — is
 * `atCapNote` in `components/kept/kept-quota.tsx`, printed underneath by the
 * same component the header and the chooser use, so there is exactly one
 * sentence in the product describing what to do about a full account.
 *
 * `DRAFT_TTL_DAYS` is substituted for `swapConsequence`'s reason: the day the
 * clock moves, a typed number is the product lying to somebody at the moment
 * they are deciding whether to trust it.
 */
export function atCapPublishNotice(name: string): string {
  return `${name} is published and live at its link right now. It landed as a draft rather than a kept page, so it expires in ${DRAFT_TTL_DAYS} days unless you keep it first. Nothing failed and nothing was lost.`;
}

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;

/**
 * A page's weight, for the card's meta line. `null` in, `null` out — a row with
 * no recorded size renders no size, rather than a confident `0 B`.
 *
 * One decimal below 10 KB and none above it: `4.2 KB` is information, `147.3 KB`
 * is noise on a line that is already competing with a date.
 */
export function formatBytes(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < BYTES_PER_KB) return `${bytes} B`;
  if (bytes < BYTES_PER_MB) {
    const kb = bytes / BYTES_PER_KB;
    return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  }
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

/**
 * A fixed, locale- and timezone-pinned date — `22 Aug 2026`.
 *
 * PINNED ON PURPOSE. This is rendered by a server component, and "3 days ago"
 * would be a clock-dependent string produced on a machine in a different
 * timezone from the reader's, refreshed never. An absolute date is true whenever
 * it is read, and pinning the locale and `UTC` keeps it identical between the
 * server, the client and the test that asserts it.
 */
const UPDATED_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function formatUpdatedAt(date: Date): string {
  return UPDATED_FORMAT.format(date);
}

/**
 * Where a card points. `/site/[slug]` lands in task 008; the link exists from
 * task 003 so the card's shape is settled before its destination is.
 */
export function siteHref(slug: string): string {
  return `/site/${slug}`;
}
