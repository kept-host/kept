"use client";

/**
 * The Pages home — every PRD §9.1 state, wired to live data (E06 task 011).
 *
 * The skin is `kept Studio Screen.dc.html` (`view: normal / empty / limit`,
 * `sheet`, `mobile`), imported rather than redesigned, with the PRD's calls
 * applied: "Your pages", visits not views, Swap… not "Make room", a Grid / List
 * toggle, paste in the sheet, and none of the later epics' elements (AC10).
 *
 * ── TWO TABS: KEPT · DRAFTS ──────────────────────────────────────────────────
 * Drafts used to stack above the kept wall, and an account an agent publishes
 * into had its wall pushed off the screen. Now each has a tab, with its count
 * (over the search, so a search says where its matches are); Kept opens by
 * default, and the tab is the URL (`?tab=drafts`) beside the view. The drafts
 * tab is `DraftsPanel` — filters, sorts, delete and Select mode.
 *
 * Grid / List applies to the open tab. With no `?view=` each tab opens on its
 * own default (`DEFAULT_VIEW`): the wall as a grid, drafts as a list — a list
 * reads far better than a wall of cards when there are dozens of drafts. An
 * explicit `?view=` is the reader's choice and applies to whichever tab is open.
 *
 * A publish switches to the tab its page will land on, so the mint card and the
 * arrival are seen. A keep from the drafts tab stays there — someone working
 * down a long list of drafts is not bounced to the wall after each one; the
 * draft fades, leaves, and the Kept count moves.
 *
 * Reads arrive as props from the server component; every mutation goes through
 * the owner client and ends in `router.refresh()` — no live updates, no store,
 * no browser storage. Search, sorts and the drafts filter are React state; the
 * tab and the view are the URL.
 */
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";

import {
  limitsFor,
  VISITS_RECENT_DAYS,
  type KeptQuota,
  type Plan,
} from "@kept/shared";

import { DRAFT_SECTION_NOTE } from "@/components/kept/draft-chip";
import { DropTarget } from "@/components/kept/drop-target";
import { Mascot } from "@/components/kept/mascot";
import { UtilityBar } from "@/components/kept/utility-bar";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatUpdatedAt, type DraftFilter } from "@/lib/sites/display";
import { cn } from "@/lib/utils";

import { Wordmark } from "../wordmark";
import { DraftsPanel, NO_IDS } from "./drafts-panel";
import { HomeCard, toSwapPage, type HomeSite } from "./home-card";
import { LimitBanner } from "./limit-banner";
import { MintCard } from "./mint-card";
import { PublishForm, PublishSheet } from "./publish-sheet";
import { NoSearchResults, TabEmpty } from "./tab-empty";
import {
  DEFAULT_DRAFT_SORT,
  DEFAULT_SORT,
  KEPT_SORTS,
  sortSites,
  Toolbar,
  type DraftSortKey,
  type SortKey,
  type View,
} from "./toolbar";
import { useArrival } from "./use-arrival";
import { usePublish } from "./use-publish";

type Tab = "kept" | "drafts";

/** Each tab's view while the URL names none — see the header. */
const DEFAULT_VIEW: Record<Tab, View> = { kept: "grid", drafts: "list" };

/** The Kept tab's line, beside the tabs (the wall heading's note, before tabs). */
const KEPT_NOTE = "Permanent. Drag a file onto a card to replace it.";

/**
 * Write one search param. The URL is the tab's and the view's only home (no
 * browser storage), and Next's router picks up `history.replaceState` without a
 * server round trip. Reads `window.location`, so it is stable for callbacks.
 */
function replaceParam(key: "tab" | "view", value: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (value === null) params.delete(key);
  else params.set(key, value);
  const search = params.toString();
  window.history.replaceState(null, "", search ? `?${search}` : window.location.pathname);
}

function matches(site: HomeSite, needle: string): boolean {
  return !needle || (site.title?.toLowerCase().includes(needle) ?? false) || site.slug.includes(needle);
}

export function PagesHome({
  kept,
  drafts,
  quota,
  names,
  plan,
  visitsAsOf,
  visitsFailed,
}: {
  kept: HomeSite[];
  drafts: HomeSite[];
  quota: KeptQuota;
  names: number;
  plan: Plan;
  visitsAsOf: Date | null;
  visitsFailed: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [retrying, startRetry] = useTransition();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>(DEFAULT_SORT);
  const [draftSort, setDraftSort] = useState<DraftSortKey>(DEFAULT_DRAFT_SORT);
  const [draftFilter, setDraftFilter] = useState<DraftFilter>("all");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  // Drafts the server has just deleted or kept, off the screen before the
  // refresh lands. Held against the `drafts` they were taken from, so fresh
  // server data always wins — a page kept now and demoted later comes back.
  const [gone, setGone] = useState({ from: drafts, ids: NO_IDS });
  const arrivals = useArrival();
  const { current: arriving, settle } = arrivals;
  const atLimit = quota.remaining === 0;
  // The request is leaving: close the sheet and open the tab the page will
  // land on, where its mint card stands (a draft at the kept limit).
  const onSend = useCallback(() => {
    setSheetOpen(false);
    replaceParam("tab", atLimit ? "drafts" : null);
  }, [atLimit]);
  const publisher = usePublish({ keptLimit: quota.limit, onSend, arrive: arrivals.arrive });

  const present = gone.from === drafts ? drafts.filter((site) => !gone.ids.has(site.id)) : drafts;
  const tab: Tab = searchParams.get("tab") === "drafts" ? "drafts" : "kept";
  const viewParam = searchParams.get("view");
  const view: View = viewParam === "grid" || viewParam === "list" ? viewParam : DEFAULT_VIEW[tab];
  const empty = kept.length === 0 && present.length === 0 && publisher.minting === null;

  const needle = query.trim().toLowerCase();
  const shownKept = sortSites(
    kept.filter((site) => matches(site, needle)),
    sort,
  );
  const matchedDrafts = present.filter((site) => matches(site, needle));
  const candidates = useMemo(() => kept.map(toSwapPage), [kept]);
  const mintCard = (variant: View | "draft") =>
    publisher.minting ? (
      <MintCard
        minting={publisher.minting}
        variant={variant}
        onRetry={publisher.retry}
        onDismiss={publisher.dismiss}
      />
    ) : null;

  // An arrival on the other tab: a publish (or the duplicate it pointed at)
  // brings its tab forward, so the page is seen landing; a keep made from the
  // drafts tab stays put, and its arrival on the wall is over unseen.
  useEffect(() => {
    if (!arriving) return;
    const landed: Tab | null = kept.some((site) => site.id === arriving.id)
      ? "kept"
      : drafts.some((site) => site.id === arriving.id)
        ? "drafts"
        : null;
    if (landed === null || landed === tab) return;
    if (arriving.kind === "kept") settle(arriving.id);
    else replaceParam("tab", landed === "kept" ? null : landed);
  }, [arriving, kept, drafts, tab, settle]);

  function hide(ids: readonly string[]) {
    setGone((previous) => ({
      from: drafts,
      ids: new Set([...(previous.from === drafts ? previous.ids : []), ...ids]),
    }));
  }

  function setTab(next: Tab) {
    replaceParam("tab", next === "kept" ? null : next);
  }

  function setView(next: View) {
    replaceParam("view", next === DEFAULT_VIEW[tab] ? null : next);
  }

  const openSheet = () => {
    publisher.clearError();
    setSheetOpen(true);
  };

  return (
    <DropTarget scope="window" disabled={publisher.busy} onFile={publisher.publishFile} onRefuse={publisher.refuse}>
      {() => (
        <>
          <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-bg px-4 md:px-8">
            <Wordmark className="text-[22px] md:hidden" />
            <label className="flex h-10 min-w-0 max-w-[420px] flex-1 items-center gap-2 rounded-[var(--r-sm)] border border-border bg-surface px-3 text-text-secondary focus-within:border-accent focus-within:ring-2 focus-within:ring-accent">
              <Search aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.5} />
              <input
                type="search"
                aria-label="Search your pages"
                placeholder="Search your pages"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-7 min-w-0 flex-1 bg-transparent font-body text-sm text-text outline-none placeholder:text-text-muted"
              />
            </label>
          </header>

          <main className="flex flex-col gap-7 px-4 pb-24 pt-8 @container md:px-10">
            <div className="flex flex-col gap-4">
              <h1 className="font-display text-[clamp(32px,6cqw,40px)] font-bold leading-[1.1] tracking-[-0.03em] text-text">
                Your pages
              </h1>
              <UtilityBar
                counts={
                  empty
                    ? null
                    : {
                        kept: quota.used,
                        keptLimit: quota.limit,
                        names,
                        nameQuota: limitsFor(plan).chosenNames,
                        drafts: present.length,
                      }
                }
                onPublish={openSheet}
              />
            </div>

            {visitsFailed ? (
              <div
                role="alert"
                data-testid="partial-error"
                className="flex flex-wrap items-center gap-3 rounded-[var(--r-lg)] border border-border bg-surface px-5 py-3 shadow-[var(--shadow-sm)]"
              >
                <p className="min-w-0 flex-1 text-[15px] text-text">We couldn&rsquo;t load your pages.</p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={retrying}
                  onClick={() => startRetry(() => router.refresh())}
                  className="font-body font-medium"
                >
                  {retrying ? "Retrying…" : "Retry"}
                </Button>
              </div>
            ) : null}

            {atLimit && !bannerDismissed ? (
              <LimitBanner limit={quota.limit} plan={plan} onDismiss={() => setBannerDismissed(true)} />
            ) : null}

            {publisher.error && !sheetOpen && !empty ? (
              <p
                role="alert"
                data-testid="publish-error"
                className="rounded-[var(--r-md)] border border-[color-mix(in_srgb,var(--danger)_35%,var(--border))] bg-surface px-4 py-3 text-sm leading-relaxed text-danger"
              >
                {publisher.error}
              </p>
            ) : null}

            {empty ? (
              <EmptyState>
                <PublishForm publisher={publisher} zoneClassName="min-h-56" />
              </EmptyState>
            ) : (
              <Tabs value={tab} onValueChange={(next) => setTab(next === "drafts" ? "drafts" : "kept")} className="gap-5">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <TabsList aria-label="Pages">
                    <TabsTrigger value="kept" className="gap-2">
                      Kept
                      <span className="text-text-muted">{shownKept.length}</span>
                    </TabsTrigger>
                    <TabsTrigger value="drafts" className="gap-2">
                      Drafts
                      <span className="text-text-muted">{matchedDrafts.length}</span>
                    </TabsTrigger>
                  </TabsList>
                  <p className="text-sm text-text-secondary">{tab === "kept" ? KEPT_NOTE : DRAFT_SECTION_NOTE}</p>
                </div>

                <TabsContent value="kept" className="flex flex-col gap-4">
                  <Toolbar
                    sorts={KEPT_SORTS}
                    sort={sort}
                    onSort={setSort}
                    view={view}
                    onView={setView}
                    note={
                      visitsAsOf
                        ? `Visits over the last ${VISITS_RECENT_DAYS} days · as of ${formatUpdatedAt(visitsAsOf)}`
                        : undefined
                    }
                  />
                  {shownKept.length > 0 || (publisher.minting && !atLimit) ? (
                    <ul
                      data-testid="kept-wall"
                      data-view={view}
                      className={cn(
                        view === "grid"
                          ? "grid grid-cols-[repeat(auto-fill,minmax(clamp(150px,22cqw,280px),1fr))] gap-[clamp(12px,2.5cqw,20px)]"
                          : "flex flex-col gap-2",
                      )}
                    >
                      {atLimit ? null : mintCard(view)}
                      {shownKept.map((site) => (
                        <HomeCard
                          key={site.id}
                          site={site}
                          variant={view}
                          plan={plan}
                          arrival={arriving?.id === site.id ? arriving : undefined}
                          onSettled={settle}
                        />
                      ))}
                    </ul>
                  ) : needle ? (
                    <NoSearchResults query={query.trim()} onClear={() => setQuery("")} />
                  ) : (
                    <TabEmpty
                      testId="kept-empty"
                      title="Nothing kept yet."
                      note="Keep a draft and it stays at its link for good."
                    />
                  )}
                </TabsContent>

                <TabsContent value="drafts">
                  <DraftsPanel
                    drafts={matchedDrafts}
                    query={query.trim()}
                    onClearSearch={() => setQuery("")}
                    sort={draftSort}
                    onSort={setDraftSort}
                    filter={draftFilter}
                    onFilter={setDraftFilter}
                    view={view}
                    onView={setView}
                    quota={quota}
                    candidates={candidates}
                    plan={plan}
                    arrivals={arrivals}
                    mint={atLimit ? mintCard(view === "grid" ? "draft" : "list") : null}
                    onGone={hide}
                  />
                </TabsContent>
              </Tabs>
            )}
          </main>

          <PublishSheet
            open={sheetOpen}
            onOpenChange={setSheetOpen}
            publisher={publisher}
            atLimit={atLimit}
            keptLimit={quota.limit}
          />
        </>
      )}
    </DropTarget>
  );
}

/** "Nothing kept yet" — mascot `plain`, the line, a large drop zone; no counters. */
function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <section data-testid="empty-state" className="flex flex-col gap-6">
      <div className="flex flex-col items-start gap-4">
        <Mascot className="block size-24 text-accent" />
        <div className="flex flex-col gap-2">
          <h2 className="font-display text-[28px] font-semibold leading-[1.15] tracking-[-0.03em] text-balance text-text">
            Nothing kept yet. Drop a file to begin.
          </h2>
          <p className="max-w-[56ch] text-base text-pretty text-text-secondary">
            Every page gets a live link the moment it lands.
          </p>
        </div>
      </div>
      <div className="max-w-[640px] rounded-[var(--r-lg)] border border-border bg-surface p-5">{children}</div>
    </section>
  );
}
