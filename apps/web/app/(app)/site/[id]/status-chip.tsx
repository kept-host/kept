"use client";

import type { SiteStatus } from "@kept/shared";

import { draftCountdown } from "@/components/kept/draft-chip";
import { STATUS_LABEL } from "@/components/kept/live-url";
import { cn } from "@/lib/utils";

/**
 * The page's state, as the header's chip says it — `kept Page Screen.dc.html`:
 * `LIVE · KEPT`, `DRAFT · 6 DAYS LEFT`, `UNDER REVIEW`. Moved here from the
 * dashboard's `SiteState` (task 011 left "where it lives next" to this task).
 *
 * `shown` is the EFFECTIVE status — the clock's, not the row's (`effectiveStatus`
 * in the caller): an expired-but-unswept draft still says `live` in Postgres
 * until E07's sweep runs, and this chip must not repeat it. The draft label is
 * `draftCountdown`'s, from the screen's one ticker.
 */
export function StatusChip({
  shown,
  expiresAt,
  now,
}: {
  shown: SiteStatus;
  /** The draft clock; `null` ⇒ kept. */
  expiresAt: Date | null;
  now: Date;
}) {
  const flagged = shown === "under_review" || shown === "quarantined";
  const label = flagged
    ? STATUS_LABEL[shown]
    : expiresAt !== null
      ? draftCountdown(expiresAt, now).label
      : shown === "live"
        ? `${STATUS_LABEL.live} · Kept`
        : STATUS_LABEL[shown];
  const dot = flagged
    ? "bg-warning"
    : shown === "expired"
      ? "bg-danger"
      : expiresAt === null && shown === "live"
        ? "bg-live"
        : null;

  return (
    <span
      data-testid="status-chip"
      data-status={shown}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-[var(--r-pill)] border px-3 font-mono text-xs font-medium uppercase tracking-[0.08em] text-text",
        flagged
          ? "border-[color-mix(in_srgb,var(--warning)_55%,var(--surface))] bg-[color-mix(in_srgb,var(--warning)_20%,var(--surface))]"
          : "border-border bg-surface",
      )}
    >
      {dot ? <span aria-hidden="true" className={cn("size-1.5 rounded-full", dot)} /> : null}
      {expiresAt !== null && !flagged ? (
        <time dateTime={expiresAt.toISOString()} title={expiresAt.toUTCString()}>
          {label}
        </time>
      ) : (
        label
      )}
    </span>
  );
}
