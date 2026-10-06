"use client";

/**
 * The Pages home's toolbar — sort and Grid / List (PRD §5.1, AC6), for whichever
 * tab is open: the kept tab sorts by `KEPT_SORTS`, the drafts tab by
 * `DRAFT_SORTS` and adds its filter chips and Select on either side.
 *
 * Sort labels follow the PRD, not the design ("visits", never "views" — design
 * call 7). Grid / List is built though the design has no toggle (call 8); the
 * view lives in the URL (`?view=`) so it survives a reload without browser
 * storage, and the page reads it back with `useSearchParams`.
 */
import type { ReactNode } from "react";
import { LayoutGrid, List } from "lucide-react";

import { pageName } from "@/lib/sites/display";
import { cn } from "@/lib/utils";

export type SortKey = "updated" | "visits" | "name";
export type View = "grid" | "list";

/** One option of a sort control. */
export interface SortOption<K extends string> {
  key: K;
  label: string;
}

/**
 * PRD §16 open question 3, answered with the PRD's default: *Recently updated*.
 * One constant, so the day it becomes *Most visited* is a one-word change.
 */
export const DEFAULT_SORT: SortKey = "updated";

export const KEPT_SORTS: readonly SortOption<SortKey>[] = [
  { key: "updated", label: "Recently updated" },
  { key: "visits", label: "Most visited" },
  { key: "name", label: "Name" },
];

export type DraftSortKey = "newest" | "oldest" | "expiring" | "name";

/**
 * The drafts tab opens on the newest publish: an agent that has just published
 * a page is the commonest reason to look, and it should lead. One constant.
 */
export const DEFAULT_DRAFT_SORT: DraftSortKey = "newest";

export const DRAFT_SORTS: readonly SortOption<DraftSortKey>[] = [
  { key: "newest", label: "Newest published" },
  { key: "oldest", label: "Oldest published" },
  { key: "expiring", label: "Expiring soonest" },
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

interface DraftSortable {
  title: string | null;
  slug: string;
  /** The first publish — "Published 3 Oct". */
  createdAt: Date;
  /** Every draft has a clock; a row whose clock was cleared sorts last. */
  expiresAt: Date | null;
}

/** The drafts in `sort` order — by first publish, by deadline, or by name. */
export function sortDrafts<T extends DraftSortable>(drafts: readonly T[], sort: DraftSortKey): T[] {
  const sorted = [...drafts];
  const deadline = (draft: T) => draft.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  switch (sort) {
    case "newest":
      return sorted.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    case "oldest":
      return sorted.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    case "expiring":
      return sorted.sort((a, b) => deadline(a) - deadline(b));
    case "name":
      return sorted.sort((a, b) => pageName(a).localeCompare(pageName(b)));
  }
}

export const SEGMENT =
  "flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[calc(var(--r-sm)-2px)] px-2.5 font-mono text-xs font-medium uppercase tracking-[0.08em] outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** A segmented control's track — the sort, the view and the drafts filters. */
export const SEGMENT_GROUP = "flex items-center gap-0.5 rounded-[var(--r-sm)] bg-sunken p-0.5";

export function segmentState(on: boolean): string {
  return on ? "bg-surface text-text shadow-[var(--shadow-sm)]" : "text-text-secondary hover:text-text";
}

export function Toolbar<K extends string>({
  sorts,
  sort,
  onSort,
  view,
  onView,
  note,
  leading,
  trailing,
}: {
  sorts: readonly SortOption<K>[];
  sort: K;
  onSort: (sort: K) => void;
  view: View;
  onView: (view: View) => void;
  /** A quiet line on the left — when the visits were last counted. */
  note?: string;
  /** Controls on the left, after the note — the drafts tab's filters. */
  leading?: ReactNode;
  /** Controls on the right, after the view — the drafts tab's Select. */
  trailing?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {note ? <p className="min-w-0 font-mono text-xs text-text-secondary">{note}</p> : null}
        {leading}
      </div>
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
        <div role="group" aria-label="Sort" className={cn(SEGMENT_GROUP, "max-w-full overflow-x-auto")}>
          {sorts.map(({ key, label }) => (
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
        <div role="group" aria-label="View" className={SEGMENT_GROUP}>
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
        {trailing}
      </div>
    </div>
  );
}
