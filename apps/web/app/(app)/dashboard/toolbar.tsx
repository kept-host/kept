"use client";

/**
 * The Pages home's toolbar — sort and Grid / List (PRD §5.1, AC6).
 *
 * Sort labels follow the PRD, not the design ("visits", never "views" — design
 * call 7). Grid / List is built though the design has no toggle (call 8); the
 * view lives in the URL (`?view=list`) so it survives a reload without browser
 * storage, and the page reads it back with `useSearchParams`.
 */
import { LayoutGrid, List } from "lucide-react";

import { pageName } from "@/lib/sites/display";
import { cn } from "@/lib/utils";

export type SortKey = "updated" | "visits" | "name";
export type View = "grid" | "list";

/**
 * PRD §16 open question 3, answered with the PRD's default: *Recently updated*.
 * One constant, so the day it becomes *Most visited* is a one-word change.
 */
export const DEFAULT_SORT: SortKey = "updated";

const SORTS: readonly { key: SortKey; label: string }[] = [
  { key: "updated", label: "Recently updated" },
  { key: "visits", label: "Most visited" },
  { key: "name", label: "Name" },
];

interface Sortable {
  title: string | null;
  slug: string;
  updatedAt: Date;
  visits: number | null;
}

/**
 * The wall in `sort` order. *Most visited* puts pages with no visit data last —
 * "no data yet" is not the same as "nobody came", and must not lead the list.
 * `Array.prototype.sort` is stable, so ties keep their recently-updated order.
 */
export function sortSites<T extends Sortable>(sites: readonly T[], sort: SortKey): T[] {
  const sorted = [...sites];
  switch (sort) {
    case "updated":
      return sorted.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    case "visits":
      return sorted.sort((a, b) => {
        if (a.visits === null) return b.visits === null ? 0 : 1;
        if (b.visits === null) return -1;
        return b.visits - a.visits;
      });
    case "name":
      return sorted.sort((a, b) => pageName(a).localeCompare(pageName(b)));
  }
}

const SEGMENT =
  "flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[calc(var(--r-sm)-2px)] px-2.5 font-mono text-xs font-medium uppercase tracking-[0.08em] outline-none focus-visible:ring-2 focus-visible:ring-accent";

function segmentState(on: boolean): string {
  return on ? "bg-surface text-text shadow-[var(--shadow-sm)]" : "text-text-secondary hover:text-text";
}

export function Toolbar({
  sort,
  onSort,
  view,
  onView,
  note,
}: {
  sort: SortKey;
  onSort: (sort: SortKey) => void;
  view: View;
  onView: (view: View) => void;
  /** A quiet line on the left — when the visits were last counted. */
  note?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="min-w-0 font-mono text-xs text-text-secondary">{note}</p>
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="Sort"
          className="flex items-center gap-0.5 overflow-x-auto rounded-[var(--r-sm)] bg-sunken p-0.5"
        >
          {SORTS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              aria-pressed={sort === key}
              onClick={() => onSort(key)}
              className={cn(SEGMENT, segmentState(sort === key))}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          role="group"
          aria-label="View"
          className="flex items-center gap-0.5 rounded-[var(--r-sm)] bg-sunken p-0.5"
        >
          <button
            type="button"
            aria-pressed={view === "grid"}
            onClick={() => onView("grid")}
            className={cn(SEGMENT, segmentState(view === "grid"))}
          >
            <LayoutGrid aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
            Grid
          </button>
          <button
            type="button"
            aria-pressed={view === "list"}
            onClick={() => onView("list")}
            className={cn(SEGMENT, segmentState(view === "list"))}
          >
            <List aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
            List
          </button>
        </div>
      </div>
    </div>
  );
}
