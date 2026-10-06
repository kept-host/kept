import { Archive, X } from "lucide-react";

import { limitsFor, type Plan } from "@kept/shared";

import { LockedRow } from "@/components/kept/locked-row";
import { atLimitBanner } from "@/lib/sites/display";

/**
 * At the kept limit — PRD §9.1 (`kept Studio Screen.dc.html`, `view: limit`).
 *
 * Publishing still works and lands as a draft, so this informs and never
 * blocks. The PRD's sentence replaces the design's "make room or apply for
 * Founding": the way out is Swap… on a draft (design call 4), and Founding is
 * E11's. Dismissal is React state — it lasts for the session, never stored.
 *
 * Free accounts also see what Pro adds as a `LockedRow` (D15: no CTA until a
 * destination exists). Pro accounts have no locked rows.
 */
export function LimitBanner({
  limit,
  plan,
  onDismiss,
}: {
  limit: number;
  plan: Plan;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      data-testid="limit-banner"
      className="rounded-[var(--r-lg)] border border-border bg-surface px-5 py-4 shadow-[var(--shadow-sm)]"
    >
      <div className="flex items-start gap-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-[var(--r-md)] bg-[color-mix(in_srgb,var(--warning)_20%,var(--surface))] text-text">
          <Archive aria-hidden="true" className="size-5" strokeWidth={1.5} />
        </span>
        <p className="min-w-0 flex-1 self-center text-[15px] leading-snug text-text">
          {atLimitBanner(limit)}
        </p>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="flex size-8 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-text-secondary outline-none hover:bg-sunken hover:text-text focus-visible:ring-2 focus-visible:ring-accent"
        >
          <X aria-hidden="true" className="size-4" strokeWidth={1.5} />
        </button>
      </div>
      {plan === "free" ? (
        <LockedRow className="mt-3 border-t border-border pb-0">
          {`Keep ${limitsFor("premium").keptPages.toLocaleString("en-US")} pages with Pro`}
        </LockedRow>
      ) : null}
    </div>
  );
}
