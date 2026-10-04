/**
 * What the page-detail Visits tab shows — PRD §5.2 / §9.2, AC34. E06 task 012.
 *
 * Pure: the rows (`dailyVisits`), the sync's standing (`lastVisitsSync`) and
 * "now" in, one of three states out. It lives in `lib/` so the unit suite can
 * assert every state against seeded rows; the tab only paints it.
 *
 * ⚠️ NEVER A BARE 0 AS THE HEADLINE. A page with no rows has no data — the sync
 * has not seen it yet, or has never run — and says so ("—" and the explainer).
 * Zero is only ever shown when the sync wrote days for this page and they sum
 * to zero, which is a fact rather than an absence.
 */
import { VISITS_HISTORY_DAYS, VISITS_STALE_HOURS } from "@kept/shared";

import type { DayVisits, VisitsSync } from "../db/queries/visits";
import { MS_PER_DAY, MS_PER_HOUR } from "./display";

/** PRD §11, verbatim. Shown under the chart in every state. */
export const VISITS_PRIVACY_LINE =
  "Counted from total traffic, approximately. kept never tracks who your visitors are.";

/** No rows for this page yet — never synced, or not yet in the data (PRD §9.2). */
export const VISITS_EMPTY_NOTE = "Visits appear the day after your page is first opened.";

/** The sync has failed and never succeeded, and this page has nothing to show. */
export const VISITS_UNAVAILABLE = "Visits aren't available right now.";

export type VisitsView =
  | { kind: "empty" }
  | { kind: "unavailable" }
  | {
      kind: "series";
      /** Exactly `VISITS_HISTORY_DAYS` complete UTC days, oldest first; gaps are 0. */
      days: DayVisits[];
      /** The sync's last success — "As of …" — or `null` when it never succeeded. */
      asOf: Date | null;
      /** The last success is older than `VISITS_STALE_HOURS`: emphasise "as of". */
      stale: boolean;
    };

/** `YYYY-MM-DD` of the UTC day `daysAgo` before `now`'s. */
function utcDay(now: Date, daysAgo: number): string {
  return new Date(now.getTime() - daysAgo * MS_PER_DAY).toISOString().slice(0, 10);
}

export function visitsView(rows: DayVisits[], sync: VisitsSync, now: Date): VisitsView {
  if (rows.length === 0) {
    return sync.lastSuccessAt === null && sync.lastError !== null
      ? { kind: "unavailable" }
      : { kind: "empty" };
  }

  const byDay = new Map(rows.map((row) => [row.day, row.visits]));
  const days: DayVisits[] = [];
  for (let ago = VISITS_HISTORY_DAYS; ago >= 1; ago--) {
    const day = utcDay(now, ago);
    days.push({ day, visits: byDay.get(day) ?? 0 });
  }

  const asOf = sync.lastSuccessAt;
  return {
    kind: "series",
    days,
    asOf,
    stale: asOf !== null && now.getTime() - asOf.getTime() > VISITS_STALE_HOURS * MS_PER_HOUR,
  };
}

/** A chart axis label — `Sep 4` — pinned to UTC like every other studio date. */
const DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function formatDay(day: string): string {
  return DAY_FORMAT.format(new Date(`${day}T00:00:00.000Z`));
}
