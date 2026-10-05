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
import {
  DRAFT_GRACE_DAYS,
  DRAFT_TTL_DAYS,
  limitsFor,
  type PublishChannel,
  type SiteStatus,
} from "@kept/shared";

import { NAME_HOLD_PERIOD } from "../names/messages";

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

/** Clock arithmetic for the studio's dates — shared, so no screen re-spells it. */
export const MS_PER_HOUR = 60 * 60 * 1000;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

/** `1 day`, `3 days`. Shared with `components/kept/draft-chip.tsx`. */
export function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * `1 visit`, `4,210 visits` — the card and the swap chooser say it the same way.
 * Vocabulary is "visits", never "views" (PRD design call 7).
 */
export function visitsLabel(visits: number): string {
  return `${visits.toLocaleString("en-US")} ${visits === 1 ? "visit" : "visits"}`;
}

/**
 * How close to `expires_at` a draft's chip turns `--warning` — PRD §9.1, AC9:
 * "Drafts in their last 48 hours show the warning chip". A display rule, not a
 * plan limit, so it lives here and not in `limitsFor`.
 */
export const DRAFT_URGENT_HOURS = 48;

/** Whether a draft is still live but inside its last `DRAFT_URGENT_HOURS`. */
export function isDraftUrgent(expiresAt: Date, now: Date): boolean {
  const remaining = expiresAt.getTime() - now.getTime();
  return remaining > 0 && remaining <= DRAFT_URGENT_HOURS * MS_PER_HOUR;
}

/**
 * What an expired draft in its grace window says on its card — PRD §5.1:
 * "Expired {n} days ago — keep within {m} days".
 *
 * `m` is counted to the row's own `purge_after` (set at publish from
 * `DRAFT_GRACE_DAYS`), never re-derived from the constant. Past `purge_after`
 * there is nothing left to keep (edge case 13), so the clause is dropped rather
 * than promising "keep within 0 days".
 */
export function expiredDraftNotice(
  expiresAt: Date,
  purgeAfter: Date | null,
  now: Date,
): string {
  const daysAgo = Math.floor((now.getTime() - expiresAt.getTime()) / MS_PER_DAY);
  const since = daysAgo < 1 ? "Expired today" : `Expired ${plural(daysAgo, "day")} ago`;
  if (purgeAfter === null) return since;
  const left = Math.ceil((purgeAfter.getTime() - now.getTime()) / MS_PER_DAY);
  return left > 0 ? `${since} — keep within ${plural(left, "day")}` : since;
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
 * The first is the standing restriction above. The second is arithmetic: a page
 * that is clockless but *not* `live` either holds no slot (archived, removed —
 * `isKeptCondition` excludes them) or is not one the server will demote
 * (`demoteSite` takes only a kept `live` page). Demoting it frees nothing, and the
 * swap would end with the account still at its kept limit and one more draft
 * than it started with. Offering it would be offering a no-op that costs the user a
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
 * What demoting a kept page does, said BEFORE it writes — the page-detail
 * Danger zone's line and its confirm dialog (`kept Page Screen.dc.html`; E06
 * task 012). Demote is the one verb there that takes something away, and the
 * endpoint confirms nothing itself (`app/api/sites/[id]/demote/route.ts`: "the
 * confirmation is the caller's") — a warning printed after the write is a
 * receipt, not a warning.
 *
 * `DRAFT_TTL_DAYS` is substituted because demote sets a FRESH clock, and a
 * typed number turns this into a lie the day the constant moves.
 */
export const DEMOTE_NOTE = `This page gets a ${DRAFT_TTL_DAYS}-day countdown again.`;

/** The dialog's second line: the deadline the fresh clock would set. */
export function demoteDeadline(expiresOn: Date): string {
  return `It expires on ${formatUpdatedAt(expiresOn)} unless you keep it again.`;
}

/** After the demote landed (the design's toast, the clock interpolated). */
export const DEMOTED_TOAST = `Made draft · ${DRAFT_TTL_DAYS} days left`;

/**
 * The Delete confirmation's body — PRD §11 verbatim, after the dialog's title
 * "Delete {page}?". The download window is `DRAFT_GRACE_DAYS` (D14: archive,
 * downloadable until `purge_after`); the hold sentence appears only when the
 * page carries a CHOSEN name, which is the only kind D4 holds.
 *
 * There is no Undo (design call 5): there is no un-archive path, so the
 * sentence says what survives rather than offering a way back.
 */
export function deletePageWarning(chosenName: string | null): string {
  const hold =
    chosenName === null
      ? ""
      : ` The name ${chosenName} stays reserved for you for ${NAME_HOLD_PERIOD}.`;
  return `The link stops working within about 2 minutes. You can download the files for ${DRAFT_GRACE_DAYS} days.${hold}`;
}

/** The Danger zone's Delete row, before anything is pressed (the design's line). */
export const DELETE_PAGE_NOTE = `The link stops working. You can still download the files for ${DRAFT_GRACE_DAYS} days.`;

/**
 * An archived page's reduced view (PRD §5.2): the page was deleted by its owner
 * and stays downloadable until `purge_after`, when E07's purge collects it.
 */
export function archivedNotice(deletedOn: Date, purgeAfter: Date | null): string {
  const deleted = `Deleted on ${formatUpdatedAt(deletedOn)}.`;
  return purgeAfter === null
    ? deleted
    : `${deleted} You can download it until ${formatUpdatedAt(purgeAfter)}.`;
}

/**
 * The studio's toasts and banners — PRD §5.1 / §5.3 / §9.1, verbatim (E06 task
 * 011). Every limit is the caller's `limitsFor(plan)` value, never typed: a Pro
 * account must not be told the free number.
 *
 * ⚠️ AT THE LIMIT IS A SUCCESS, NOT A REFUSAL. A publish past the kept limit
 * lands as a draft (D9) — the page is live — so its sentence opens with
 * "Published", never with what went wrong.
 */
export const PUBLISHED_KEPT_TOAST = "Published. It's kept.";

export function atLimitPublishToast(limit: number): string {
  return `Published as a draft — you're keeping ${limit} of ${limit}. Swap one out to keep it.`;
}

export const KEPT_TOAST = "Kept. It's permanent now.";

export const SWAPPED_TOAST = "Swapped.";

/**
 * The publish moment (E06 task 015, the design's `publish()`): the arriving
 * card's chip, and what the publish toast's Copy link turns it into. A refused
 * clipboard says so instead of flashing a "copied" that did not happen.
 */
export const JUST_PUBLISHED = "Just published";

export const LINK_COPIED_TOAST = "Link copied";

export const COPY_FAILED = "Could not copy the link. Select it and copy manually.";

/** The dismissible banner on the home while the account is at its kept limit. */
export function atLimitBanner(limit: number): string {
  return `You're keeping ${limit} of ${limit}. New pages land as drafts — swap one out to keep it.`;
}

/** A replace that wrote a new version (PRD §5.5); the toast carries Undo. */
export const REPLACED_TOAST = "Replaced. Same link, new version.";

/** After Undo restored the version that was current before the replace. */
export const UNDONE_TOAST = "Restored the previous version.";

/**
 * Added to the replace toast, once per session, when the free plan's version
 * limit pruned the oldest version (PRD §5.5). The count is the plan's.
 */
export function prunedVersionsNote(previousVersions: number): string {
  const kept = previousVersions === 1 ? "one previous version" : plural(previousVersions, "previous version");
  return `Free accounts keep ${kept}.`;
}

/** The home's search found nothing. */
export function noSearchResults(query: string): string {
  return `No pages match '${query}'.`;
}

/**
 * What a signed-in publish of bytes this account ALREADY has live says — PRD
 * §5.1, AC8. `POST /api/sites` answered `200 { site, duplicate: true }`: no new
 * page was made, and the existing one is the answer. The PRD's sentence,
 * verbatim.
 */
export const ALREADY_PUBLISHED_NOTICE = "You've already published this page.";

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
 * A date and a time, pinned like `formatUpdatedAt` — `3 Oct 2026, 14:20 UTC`.
 * For the version list and the visits "as of", where two events on one day
 * must still read apart and a client in another timezone must render the same
 * string the server did.
 */
const STAMP_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

export function formatTimestamp(date: Date): string {
  return `${STAMP_FORMAT.format(date)} UTC`;
}

/** How a version was published, in the Versions list (PRD §5.5; E09 brings agents). */
export const CHANNEL_LABEL: Record<PublishChannel, string> = {
  web: "Web",
  studio: "Studio",
  api: "API",
  mcp: "Agent",
};

/** A page with one version — PRD §9.2, verbatim. */
export const FIRST_VERSION_NOTE =
  "This is the first version. Replace it and the old one stays here for undo.";

/** After restoring an older version from the list. */
export function restoredToast(stamp: string): string {
  return `Restored the version from ${stamp}.`;
}

/** The restore confirmation, before the pointer moves (PRD §9.2: restore confirm). */
export function restoreWarning(stamp: string): string {
  return `The version from ${stamp} goes live at the same link within about 2 minutes. The current one stays in the list.`;
}

/** The Versions tab's locked row on Free (D15) — the Pro count from `limitsFor`. */
export const PRO_VERSIONS_LINE = `Keep ${limitsFor("premium").previousVersions} versions with Pro`;

/**
 * Where a card points: the page-detail screen, `/site/[id]` — by the page's
 * id, never its name, because names change (rename, and drafts carry
 * generated ones) and a link keyed by name breaks on every rename (D2).
 */
export function siteHref(id: string): string {
  return `/site/${id}`;
}

/**
 * The owner-only `GET /api/sites/:id/download` (task 008): the page's current
 * HTML as an attachment for a link, and as text for the card's hover preview.
 */
export function pageDownloadHref(id: string): string {
  return `/api/sites/${id}/download`;
}
