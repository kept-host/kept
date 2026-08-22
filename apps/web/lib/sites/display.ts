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
import type { SiteStatus } from "@kept/shared";

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
 * Download is deliberately not promised here. The E07 policy grants a download
 * window, but no download control exists yet, and copy that offers one would be
 * the interface lying about a button that is not on the screen.
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
