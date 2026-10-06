"use client";

/**
 * The Visits tab (the design's "Stats") — PRD §5.2 item 1, §9.2, AC34. E06
 * task 012.
 *
 * Daily bars in `--accent`, the period's total, "As of …" and the privacy line.
 * The 7 / 30 DAYS toggle (design call 10) is a client-side slice of the SAME
 * `VISITS_HISTORY_DAYS` rows — no second read. The states are `visitsView`'s:
 * "—" with the explainer when there is no data, "Visits aren't available right
 * now." when the sync has only ever failed, and a stale series with its "as
 * of" emphasised. Never a bare 0 as the headline.
 *
 * Not rendered (D8 stores per-hostname totals only): top referrers, top
 * countries.
 */
import { useState } from "react";

import { VISITS_HISTORY_DAYS, VISITS_RECENT_DAYS } from "@kept/shared";

import { formatTimestamp, visitsLabel } from "@/lib/sites/display";
import {
  formatDay,
  VISITS_EMPTY_NOTE,
  VISITS_PRIVACY_LINE,
  VISITS_UNAVAILABLE,
  type VisitsView,
} from "@/lib/sites/visits-view";
import { cn } from "@/lib/utils";

import { Section } from "./section";

const RANGES = [VISITS_RECENT_DAYS, VISITS_HISTORY_DAYS] as const;
type Range = (typeof RANGES)[number];

export function VisitsPanel({ view }: { view: VisitsView }) {
  const [range, setRange] = useState<Range>(VISITS_HISTORY_DAYS);

  const toggle =
    view.kind === "series" ? (
      <div role="group" aria-label="Range" className="flex gap-0.5 rounded-[var(--r-sm)] bg-sunken p-0.5">
        {RANGES.map((days) => (
          <button
            key={days}
            type="button"
            aria-pressed={range === days}
            onClick={() => setRange(days)}
            className={cn(
              "h-7 rounded-[6px] px-2.5 font-mono text-xs font-medium uppercase tracking-[0.08em] text-text outline-none focus-visible:ring-2 focus-visible:ring-accent",
              range === days && "bg-surface shadow-[var(--shadow-sm)]",
            )}
          >
            {days} days
          </button>
        ))}
      </div>
    ) : null;

  return (
    <Section title="Visits" status={toggle} testId="visits-panel" className="gap-4">
      {view.kind === "series" ? (
        <Series view={view} range={range} />
      ) : (
        <div data-testid="visits-empty" className="flex flex-col gap-1">
          <span aria-hidden="true" className="font-display text-[28px] leading-none font-bold tracking-[-0.03em] text-text">
            —
          </span>
          <p data-testid="visits-state" data-state={view.kind} className="text-sm text-text-secondary">
            {view.kind === "unavailable" ? VISITS_UNAVAILABLE : VISITS_EMPTY_NOTE}
          </p>
        </div>
      )}
      <p className="text-[13px] leading-relaxed text-text-secondary">{VISITS_PRIVACY_LINE}</p>
    </Section>
  );
}

function Series({ view, range }: { view: Extract<VisitsView, { kind: "series" }>; range: Range }) {
  const days = view.days.slice(-range);
  const total = days.reduce((sum, day) => sum + day.visits, 0);
  const max = Math.max(1, ...days.map((day) => day.visits));
  const first = days[0];
  const last = days.at(-1);

  return (
    <>
      <div className="flex items-baseline gap-2.5">
        <span
          data-testid="visits-total"
          className="font-display text-[28px] leading-none font-bold tracking-[-0.03em] text-text"
        >
          {total.toLocaleString("en-US")}
        </span>
        <span className="text-sm text-text-secondary">{total === 1 ? "visit" : "visits"}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <div
          role="img"
          aria-label={`Visits per day, last ${range} days, ${visitsLabel(total)} in all`}
          data-testid="visits-chart"
          className={cn("flex h-28 items-end border-b border-border", range === VISITS_RECENT_DAYS ? "gap-2" : "gap-[3px]")}
        >
          {days.map((day) => (
            <span
              key={day.day}
              title={`${formatDay(day.day)} · ${visitsLabel(day.visits)}`}
              data-testid="visits-bar"
              className="min-w-[2px] flex-1 rounded-t-[3px] bg-accent"
              style={{ height: `${Math.round((day.visits / max) * 100)}%` }}
            />
          ))}
        </div>
        <div className="flex justify-between font-mono text-xs uppercase text-text-secondary">
          <span>{first ? formatDay(first.day) : null}</span>
          <span>{last ? formatDay(last.day) : null}</span>
        </div>
      </div>

      {view.asOf ? (
        <p
          data-testid="visits-as-of"
          data-stale={view.stale ? "true" : undefined}
          className={cn(
            "flex items-center gap-2 font-mono text-xs uppercase tracking-[0.08em]",
            view.stale ? "font-medium text-text" : "text-text-secondary",
          )}
        >
          {view.stale ? <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" /> : null}
          As of {formatTimestamp(view.asOf)}
        </p>
      ) : null}
    </>
  );
}
