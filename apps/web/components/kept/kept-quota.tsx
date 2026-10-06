import type { KeptQuota } from "@kept/shared";

import { cn } from "@/lib/utils";

/**
 * The kept allowance, rendered — E06 task 002.
 *
 * ONE COMPONENT, FOUR CALL SITES: the dashboard header, the swap chooser, the
 * keep button and the publish drop-zone notice. They must never disagree, and
 * the cheapest way to guarantee that is for there to be exactly one function
 * producing the number (`keptQuotaFor` in `lib/sites/keep.ts`) and exactly one
 * component rendering it. A screen that formats `used`/`limit` itself is how the
 * four drift.
 *
 * EVERY NUMBER COMES OFF THE `KeptQuota` the server computed — whose `limit` is
 * the account's own plan's (`limitsFor(plan)`, D1). There is no typed limit
 * below — including inside the prose, for the same reason `draft-chip.tsx` has
 * no `7`: the day the cap moves, or the account changes plan, a typed number
 * turns the product into a liar.
 *
 * THE CAP IS NOT AN ERROR AND MUST NOT READ LIKE ONE. Publishing at the limit
 * lands a draft, keeping at the limit returns `owned_draft` at HTTP 200 — the
 * cap degrades, it never fails. So the at-cap state is painted in the accent,
 * not in `--danger`, and its sentence always names a way forward.
 */

/**
 * What to do when the account is full. Two real routes out, never a dead end:
 * swap (which costs nothing and destroys nothing) or Pro (E11).
 *
 * Exported so the drop-zone notice and the swap chooser say the same sentence
 * rather than two near-identical ones. A function of `limit`, never a constant:
 * the number is the account's plan's (`KeptQuota.limit`), not the free one.
 */
export function atCapNote(limit: number): string {
  return `That is all ${limit} kept pages in use. Swap one out — it becomes a draft again, nothing is deleted — or go Pro for more room.`;
}

export function KeptQuotaChip({
  quota,
  note = false,
  className,
}: {
  quota: KeptQuota;
  /** Show `atCapNote` underneath when the account is full. Off by default. */
  note?: boolean;
  className?: string;
}) {
  const atCap = quota.remaining === 0;

  return (
    <div className={cn("flex flex-col items-start gap-2", className)}>
      <span
        className={cn(
          "mono-label inline-flex items-center gap-2 rounded-[var(--r-pill)] border px-3 py-1 text-[11px] shadow-[var(--shadow-sm)]",
          atCap
            ? "border-accent bg-accent-soft text-accent"
            : "border-border bg-surface text-text-secondary",
        )}
      >
        <span
          aria-hidden="true"
          className={cn("size-1.5 rounded-full", atCap ? "bg-accent" : "bg-live")}
        />
        {/* One string, not three spans: a screen reader should hear
            "Kept · N of {limit}", not the digits stranded from their labels. */}
        {`Kept · ${quota.used} of ${quota.limit}`}
      </span>

      {note && atCap ? (
        <p className="max-w-prose font-body text-sm text-text-secondary">{atCapNote(quota.limit)}</p>
      ) : null}
    </div>
  );
}
