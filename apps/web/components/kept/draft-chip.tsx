import { DRAFT_GRACE_DAYS, DRAFT_TTL_DAYS } from "@kept/shared";

import { cn } from "@/lib/utils";

/**
 * The draft clock, as a chip and as a sentence — shared by `/p/[anonToken]`
 * (task 008) and `/keep/[anonToken]` (task 009).
 *
 * EVERY NUMBER ON THIS SCREEN COMES FROM `@kept/shared`. This is the screen
 * where the product makes its promise to a person in words — seven days, thirty
 * days, free — so a literal `7` here is not a style problem, it is the product
 * lying to somebody who trusted it the day `DRAFT_TTL_DAYS` changes. There is no
 * `7` and no `30` below, including inside the prose.
 *
 * `isDraft = expires_at != null` is the derived predicate; there is no draft
 * status to read, and this component must not invent one.
 */

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export type DraftPhase = "kept" | "draft" | "expired";

export interface DraftCountdown {
  phase: DraftPhase;
  /** Chip text, e.g. `Draft · 6 days left`. */
  label: string;
}

/**
 * The prose under the live URL. Composed from the constants for the reason at
 * the top of this file — the PRD's wording, with the numbers substituted rather
 * than typed.
 */
export const DRAFT_PROMISE = `No account needed to share. Keep it within ${DRAFT_TTL_DAYS} days — free — or this draft expires (recoverable for ${DRAFT_GRACE_DAYS} days after).`;

/** What a replace does and does not do to the clock. Task 006 enforces it. */
export const REPLACE_CLOCK_NOTE = `Replacing swaps the file and keeps the URL. It does not extend the draft — the ${DRAFT_TTL_DAYS}-day clock keeps running from when this page was first published.`;

/**
 * What a delete leaves behind. ARCHIVE, NEVER DESTROY: the bytes stay until
 * E07's grace-end job, so "deleted forever" would be a lie the grace window
 * contradicts. Says only what survives — the sentence about serving stopping
 * belongs to whichever screen is saying it, and would read twice if it were here.
 */
export const DELETE_GRACE_NOTE = `Nothing is destroyed today — the page stays recoverable for ${DRAFT_GRACE_DAYS} days before it is deleted for good.`;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * Resolve a page's clock into a phase and a label.
 *
 * `now` is a parameter rather than a `Date.now()` call so the caller decides
 * when "now" is — which is what keeps a server-rendered chip and its hydrated
 * counterpart from disagreeing by a few milliseconds and tripping a hydration
 * mismatch.
 */
export function draftCountdown(
  expiresAt: Date | null,
  now: Date = new Date(),
): DraftCountdown {
  if (!expiresAt) return { phase: "kept", label: "Kept · permanent" };

  const remaining = expiresAt.getTime() - now.getTime();

  if (remaining <= 0) {
    return { phase: "expired", label: "Draft · expired" };
  }
  if (remaining < MS_PER_HOUR) {
    return { phase: "draft", label: "Draft · under an hour left" };
  }
  if (remaining < MS_PER_DAY) {
    return {
      phase: "draft",
      label: `Draft · ${plural(Math.floor(remaining / MS_PER_HOUR), "hour")} left`,
    };
  }
  return {
    phase: "draft",
    label: `Draft · ${plural(Math.ceil(remaining / MS_PER_DAY), "day")} left`,
  };
}

const DOT_CLASS: Record<DraftPhase, string> = {
  kept: "bg-accent",
  draft: "bg-warning",
  expired: "bg-danger",
};

/**
 * The chip itself. Presentational and server-safe — it holds no state and reads
 * no clock of its own.
 */
export function DraftChip({
  expiresAt,
  now,
  className,
}: {
  expiresAt: Date | null;
  now?: Date;
  className?: string;
}) {
  const { phase, label } = draftCountdown(expiresAt, now);

  return (
    <span
      className={cn(
        "mono-label inline-flex items-center gap-2 rounded-[var(--r-pill)] border border-border bg-surface px-3 py-1 text-[11px] text-text-secondary shadow-[var(--shadow-sm)]",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", DOT_CLASS[phase])}
      />
      {expiresAt ? (
        // The machine-readable deadline rides along with the human one, so the
        // exact instant is available on hover and to assistive tech.
        <time dateTime={expiresAt.toISOString()} title={expiresAt.toUTCString()}>
          {label}
        </time>
      ) : (
        label
      )}
    </span>
  );
}
