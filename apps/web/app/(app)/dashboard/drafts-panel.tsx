"use client";

/**
 * The Pages home's Drafts tab — built for MANY drafts: agents publish a lot of
 * them, and kept is capped.
 *
 *   · Filters, each with its count over the search: All · Expiring soon (the
 *     warning chip's `DRAFT_URGENT_HOURS`) · Expired (still in grace — past it a
 *     draft never reaches this screen, `isPastGrace`).
 *   · Sorts: `DRAFT_SORTS`, newest published first (`DEFAULT_DRAFT_SORT`).
 *   · Each draft: Keep (Swap… at the limit, `KeepAction`) and Delete, behind a
 *     small confirm.
 *   · Select mode: a checkbox per draft, Select all (N shown) / Clear,
 *     shift-click for a range, Esc to leave; a sticky bar keeps or deletes the
 *     selection in one `POST /api/sites/bulk`. Keep is all or nothing within the
 *     free kept slots, so past them it is disabled with `bulkKeepRefusal`'s
 *     sentence — the server refuses with the same one.
 *
 * DELETE IS THE OWNER DELETE, per page and in bulk (D14): archived, offline
 * now, downloadable until `purge_after`, a chosen name held — no Undo (design
 * call 5). After a write: the studio's inverted toast, then `router.refresh()`.
 * A draft the server has deleted or kept leaves the list at once (`onGone`),
 * before the refresh lands.
 */
import { useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ListChecks, Trash2 } from "lucide-react";
import { toast } from "sonner";

import type { BulkItemResult, KeptQuota, Plan } from "@kept/shared";

import type { SwapPage } from "@/components/kept/swap-dialog";
import { Button } from "@/components/ui/button";
import {
  bulkFailedToast,
  bulkKeepRefusal,
  deleteDraftsNote,
  deleteDraftsTitle,
  DRAFT_FILTERS,
  DRAFT_URGENT_HOURS,
  draftMatchesFilter,
  draftsDeletedToast,
  draftsKeptToast,
  pageName,
  type DraftFilter,
} from "@/lib/sites/display";
import { bulkPages, deletePage } from "@/lib/sites/owner-client";
import { cn } from "@/lib/utils";

import { ConfirmDialog } from "../site/[id]/confirm-dialog";
import { useNow } from "./clock";
import { HomeCard, toSwapPage, type HomeSite } from "./home-card";
import { KeepAction } from "./keep-action";
import { NoSearchResults, TabEmpty } from "./tab-empty";
import {
  DRAFT_SORTS,
  SEGMENT,
  SEGMENT_GROUP,
  segmentState,
  sortDrafts,
  Toolbar,
  type DraftSortKey,
  type View,
} from "./toolbar";
import type { Arrivals } from "./use-arrival";

const FILTER_LABEL: Record<DraftFilter, string> = {
  all: "All",
  expiring: "Expiring soon",
  expired: "Expired",
};

/** A filter that matched nothing, while the search did. */
const FILTER_EMPTY: Record<Exclude<DraftFilter, "all">, string> = {
  expiring: `No drafts expire in the next ${DRAFT_URGENT_HOURS} hours.`,
  expired: "No expired drafts.",
};

export const NO_IDS: ReadonlySet<string> = new Set();

/**
 * Which drafts the confirm is about: one, from its card, or the selection. Kept
 * after the dialog closes, so its title does not change while it fades out.
 */
interface Confirming {
  open: boolean;
  ids: string[];
  /** The one draft's address, for the toast; absent for a selection. */
  host?: string;
}

export function DraftsPanel({
  drafts,
  query,
  onClearSearch,
  sort,
  onSort,
  filter,
  onFilter,
  view,
  onView,
  quota,
  candidates,
  plan,
  arrivals,
  mint,
  onGone,
}: {
  /** The drafts the search matches. */
  drafts: HomeSite[];
  query: string;
  onClearSearch: () => void;
  sort: DraftSortKey;
  onSort: (sort: DraftSortKey) => void;
  filter: DraftFilter;
  onFilter: (filter: DraftFilter) => void;
  view: View;
  onView: (view: View) => void;
  quota: KeptQuota;
  /** The kept pages — the swap chooser's list. */
  candidates: SwapPage[];
  plan: Plan;
  arrivals: Arrivals;
  /** The mint card, while a publish is landing here (at the kept limit). */
  mint: ReactNode;
  /** The server has deleted or kept these drafts: they leave the screen now. */
  onGone: (ids: readonly string[]) => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const now = new Date(useNow());
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(NO_IDS);
  const anchor = useRef<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming>({ open: false, ids: [] });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const refusalId = useId();

  const inFilter = (site: HomeSite, which: DraftFilter) =>
    site.expiresAt !== null && draftMatchesFilter(site.expiresAt, which, now);
  const shown = sortDrafts(
    drafts.filter((site) => inFilter(site, filter)),
    sort,
  );
  const chosen = shown.filter((site) => selected.has(site.id));
  const keepRefusal = bulkKeepRefusal(chosen.length, quota.remaining, quota.limit);
  const atLimit = quota.remaining === 0;

  useEffect(() => {
    return () => abort.current?.abort();
  }, []);

  // Esc leaves Select mode — unless a confirm is open, which Esc closes instead.
  useEffect(() => {
    if (!selecting || confirming.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSelecting(false);
      setSelected(NO_IDS);
      anchor.current = null;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting, confirming.open]);

  const refresh = () => startTransition(() => router.refresh());

  function controller(): AbortController {
    abort.current?.abort();
    abort.current = new AbortController();
    return abort.current;
  }

  function exitSelect() {
    setSelecting(false);
    setSelected(NO_IDS);
    anchor.current = null;
  }

  /** Tick or untick one draft; with Shift, every draft between it and the last one clicked. */
  function toggle(id: string, range: boolean) {
    const ids = shown.map((site) => site.id);
    const from = range && anchor.current ? ids.indexOf(anchor.current) : -1;
    const to = ids.indexOf(id);
    const span = from === -1 ? [id] : ids.slice(Math.min(from, to), Math.max(from, to) + 1);
    const on = !selected.has(id);
    setSelected((previous) => {
      const next = new Set(previous);
      for (const each of span) {
        if (on) next.add(each);
        else next.delete(each);
      }
      return next;
    });
    anchor.current = id;
  }

  /** Report a bulk verb's per-page results; the refused ones stay selected. */
  function settle(results: BulkItemResult[], verb: "kept" | "deleted") {
    const done = results.filter((item) => item.ok).map((item) => item.id);
    const refused = results.filter((item) => !item.ok);
    onGone(done);
    if (done.length > 0) {
      toast.success(verb === "kept" ? draftsKeptToast(done.length) : draftsDeletedToast(done.length));
    }
    const first = refused[0];
    if (first && !first.ok) {
      toast.error(bulkFailedToast(refused.length, verb, first.message));
      setSelected(new Set(refused.map((item) => item.id)));
    } else {
      exitSelect();
    }
    refresh();
  }

  async function keepSelected() {
    setPending(true);
    const signal = controller().signal;
    const outcome = await bulkPages(
      "keep",
      chosen.map((site) => site.id),
      signal,
    );
    // Gone from the screen mid-request: the write stands, but nothing is left to tell.
    if (signal.aborted) return;
    setPending(false);
    if (!outcome.ok) {
      // The whole request was refused (the slots filled up in another tab):
      // nothing was kept. The refresh brings the real quota, and the bar's
      // sentence with it.
      toast.error(outcome.error.message);
      refresh();
      return;
    }
    settle(outcome.results, "kept");
  }

  async function confirmDelete() {
    const { ids, host } = confirming;
    setPending(true);
    setError(null);
    const signal = controller().signal;

    if (host !== undefined) {
      // One draft, from its card: the single owner DELETE.
      const outcome = await deletePage(ids[0]!, signal);
      if (signal.aborted) return;
      setPending(false);
      if (!outcome.ok) {
        setError(outcome.error.message);
        return;
      }
      setConfirming({ ...confirming, open: false });
      onGone(ids);
      toast.success(draftsDeletedToast(1), { description: host });
      refresh();
      return;
    }

    const outcome = await bulkPages("delete", ids, signal);
    if (signal.aborted) return;
    setPending(false);
    if (!outcome.ok) {
      setError(outcome.error.message);
      return;
    }
    setConfirming({ ...confirming, open: false });
    settle(outcome.results, "deleted");
  }

  function ask(ids: string[], host?: string) {
    setError(null);
    setConfirming({ open: true, ids, host });
  }

  const filters = (
    <div role="group" aria-label="Show" className={SEGMENT_GROUP}>
      {DRAFT_FILTERS.map((key) => (
        <button
          key={key}
          type="button"
          aria-pressed={filter === key}
          onClick={() => onFilter(key)}
          className={cn(SEGMENT, segmentState(filter === key))}
        >
          {FILTER_LABEL[key]}
          <span className="text-text-muted">{drafts.filter((site) => inFilter(site, key)).length}</span>
        </button>
      ))}
    </div>
  );

  const selectButton = selecting ? null : (
    <button
      type="button"
      data-testid="select-drafts"
      disabled={shown.length === 0}
      onClick={() => setSelecting(true)}
      className={cn(
        SEGMENT,
        "h-8 border border-border bg-surface text-text hover:bg-sunken disabled:pointer-events-none disabled:opacity-60",
      )}
    >
      <ListChecks aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
      Select
    </button>
  );

  function selector(site: HomeSite) {
    if (!selecting) return undefined;
    return (
      <label
        className={cn(
          "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[var(--r-sm)]",
          view === "grid" && "bg-surface shadow-[var(--shadow-sm)]",
        )}
      >
        <input
          type="checkbox"
          data-testid="select-draft"
          checked={selected.has(site.id)}
          aria-label={`Select ${pageName(site)}`}
          // A checkbox's change is dispatched from its click, so Shift is on it.
          onChange={(event) => toggle(site.id, (event.nativeEvent as MouseEvent).shiftKey === true)}
          className="size-[18px] cursor-pointer accent-accent"
        />
      </label>
    );
  }

  let body: ReactNode;
  if (drafts.length === 0 && !mint) {
    body = query ? (
      <NoSearchResults query={query} onClear={onClearSearch} />
    ) : (
      <TabEmpty
        testId="drafts-empty"
        title="No drafts right now."
        note="A page you publish past your kept limit waits here as a draft."
      />
    );
  } else if (filter !== "all" && shown.length === 0 && !mint) {
    body = (
      <TabEmpty
        title={FILTER_EMPTY[filter]}
        note="Every other draft is under All."
        action={
          <Button type="button" variant="secondary" size="sm" onClick={() => onFilter("all")} className="font-body font-medium">
            Show all drafts
          </Button>
        }
      />
    );
  } else {
    body = (
      <ul
        data-testid="drafts-list"
        data-view={view}
        className={cn(
          // A draft card carries Keep and Delete beside its name, so it needs more
          // width than a kept card to leave the name readable.
          view === "grid" ? "grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-3" : "flex flex-col gap-2",
        )}
      >
        {mint}
        {shown.map((site) => {
          const host = new URL(site.liveUrl).host;
          const name = pageName(site);
          return (
            <HomeCard
              key={site.id}
              site={site}
              variant={view === "grid" ? "draft" : "draft-list"}
              plan={plan}
              arrival={arrivals.current?.id === site.id ? arrivals.current : undefined}
              onSettled={arrivals.settle}
              leaving={arrivals.leavingId === site.id}
              selector={selector(site)}
              selected={selecting && selected.has(site.id)}
              action={
                <>
                  <KeepAction
                    page={toSwapPage(site)}
                    atLimit={atLimit}
                    candidates={candidates}
                    quota={quota}
                    onKept={arrivals.keep}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    data-testid="delete-draft"
                    aria-label={`Delete draft ${name}`}
                    title="Delete draft"
                    onClick={() => ask([site.id], host)}
                    className="size-9 px-0"
                  >
                    <Trash2 aria-hidden="true" strokeWidth={1.5} />
                  </Button>
                </>
              }
            />
          );
        })}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Toolbar
        sorts={DRAFT_SORTS}
        sort={sort}
        onSort={onSort}
        view={view}
        onView={onView}
        leading={filters}
        trailing={selectButton}
      />

      {selecting ? (
        <div
          data-testid="selection-bar"
          className="sticky top-[4.5rem] z-10 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--r-lg)] border border-border bg-surface px-3 py-2 shadow-[var(--shadow-md)]"
        >
          <p aria-live="polite" className="font-mono text-xs font-medium uppercase tracking-[0.08em] text-text">
            {chosen.length} selected
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending || chosen.length === shown.length}
            onClick={() => setSelected(new Set(shown.map((site) => site.id)))}
            className="font-body font-medium"
          >
            Select all ({shown.length} shown)
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending || chosen.length === 0}
            onClick={() => setSelected(NO_IDS)}
            className="font-body font-medium"
          >
            Clear
          </Button>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {keepRefusal ? (
              <p id={refusalId} className="text-[13px] text-text-secondary">
                {keepRefusal}
              </p>
            ) : null}
            <Button
              type="button"
              size="sm"
              data-testid="keep-selected"
              disabled={pending || chosen.length === 0 || keepRefusal !== null}
              aria-describedby={keepRefusal ? refusalId : undefined}
              onClick={keepSelected}
              className="font-body font-medium"
            >
              {pending && !confirming.open ? "Keeping…" : "Keep"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="delete-selected"
              disabled={pending || chosen.length === 0}
              onClick={() => ask(chosen.map((site) => site.id))}
              className="border-danger font-body font-medium"
            >
              <Trash2 aria-hidden="true" strokeWidth={1.5} className="text-danger" />
              Delete
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={exitSelect}
              className="font-body font-medium"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {body}

      <ConfirmDialog
        open={confirming.open}
        onOpenChange={(open) => setConfirming({ ...confirming, open })}
        title={deleteDraftsTitle(confirming.ids.length)}
        description={deleteDraftsNote(confirming.ids.length)}
        confirmLabel={pending ? "Deleting…" : "Delete"}
        confirmVariant="destructive"
        testId="delete-drafts-dialog"
        pending={pending}
        error={error}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
