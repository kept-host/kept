"use client";

/**
 * The Pages home — every PRD §9.1 state, wired to live data (E06 task 011).
 *
 * The skin is `kept Studio Screen.dc.html` (`view: normal / empty / limit`,
 * `sheet`, `mobile`), imported rather than redesigned, with the PRD's calls
 * applied: "Your pages", visits not views, Swap… not "Make room", a Grid / List
 * toggle, paste in the sheet, and none of the later epics' elements (AC10).
 *
 * Reads arrive as props from the server component; every mutation goes through
 * the owner client and ends in `router.refresh()` — no live updates, no store,
 * no browser storage. Search and sort are React state; the view is the URL.
 */
import { useCallback, useMemo, useState, useTransition } from "react";
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
import type { SwapPage } from "@/components/kept/swap-dialog";
import { UtilityBar } from "@/components/kept/utility-bar";
import { Button } from "@/components/ui/button";
import { formatUpdatedAt, noSearchResults, pageName } from "@/lib/sites/display";
import { cn } from "@/lib/utils";

import { Wordmark } from "../wordmark";
import { HomeCard, type HomeSite } from "./home-card";
import { KeepAction } from "./keep-action";
import { LimitBanner } from "./limit-banner";
import { MintCard } from "./mint-card";
import { PublishForm, PublishSheet } from "./publish-sheet";
import { DEFAULT_SORT, sortSites, Toolbar, type SortKey, type View } from "./toolbar";
import { useArrival } from "./use-arrival";
import { usePublish } from "./use-publish";

function toSwapPage(site: HomeSite): SwapPage {
  return {
    id: site.id,
    name: pageName(site),
    slug: site.slug,
    liveUrl: site.liveUrl,
    status: site.status,
    visits: site.visits,
  };
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
  const [sheetOpen, setSheetOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const arrivals = useArrival();
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const publisher = usePublish({ keptLimit: quota.limit, onSend: closeSheet, arrive: arrivals.arrive });

  const view: View = searchParams.get("view") === "list" ? "list" : "grid";
  const atLimit = quota.remaining === 0;
  const empty = kept.length === 0 && drafts.length === 0 && publisher.minting === null;

  const needle = query.trim().toLowerCase();
  const shownDrafts = drafts.filter((site) => matches(site, needle));
  const shownKept = sortSites(
    kept.filter((site) => matches(site, needle)),
    sort,
  );
  const noResults = needle !== "" && shownDrafts.length === 0 && shownKept.length === 0;
  const candidates = useMemo(() => kept.map(toSwapPage), [kept]);
  const arrivalFor = (site: HomeSite) =>
    arrivals.current?.id === site.id ? arrivals.current : undefined;
  const mintCard = (variant: View | "draft") =>
    publisher.minting ? (
      <MintCard
        minting={publisher.minting}
        variant={variant}
        onRetry={publisher.retry}
        onDismiss={publisher.dismiss}
      />
    ) : null;

  function setView(next: View) {
    // The URL is the view's only home (no browser storage), and Next's router
    // picks up `history.replaceState` without a server round trip.
    const params = new URLSearchParams(searchParams.toString());
    if (next === "list") params.set("view", "list");
    else params.delete("view");
    const search = params.toString();
    window.history.replaceState(null, "", search ? `?${search}` : window.location.pathname);
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
                        drafts: drafts.length,
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
              <>
                <Toolbar
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

                {shownDrafts.length > 0 || (publisher.minting && atLimit) ? (
                  <section aria-label="Drafts" className="flex flex-col gap-3">
                    <SectionHeading
                      title="Drafts"
                      note={DRAFT_SECTION_NOTE}
                    />
                    <ul
                      data-testid="drafts-strip"
                      // Three across at most, then the strip scrolls sideways (the
                      // design's strip); a lone draft does not stretch the full width.
                      // The scroller clips, so it is padded (and pulled back by as
                      // much) for an arriving card's ring pulse to spread into.
                      className="-m-3 grid auto-cols-[minmax(250px,calc((100%-1.5rem)/3))] grid-flow-col gap-3 overflow-x-auto p-3 pb-4"
                    >
                      {atLimit ? mintCard("draft") : null}
                      {shownDrafts.map((site) => (
                        <HomeCard
                          key={site.id}
                          site={site}
                          variant="draft"
                          plan={plan}
                          arrival={arrivalFor(site)}
                          onSettled={arrivals.settle}
                          leaving={arrivals.leavingId === site.id}
                          action={
                            <KeepAction
                              page={toSwapPage(site)}
                              atLimit={atLimit}
                              candidates={candidates}
                              quota={quota}
                              onKept={arrivals.keep}
                            />
                          }
                        />
                      ))}
                    </ul>
                  </section>
                ) : null}

                {shownKept.length > 0 || (publisher.minting && !atLimit) ? (
                  <section aria-label="Kept pages" className="flex flex-col gap-3">
                    <SectionHeading title="Kept" note="Permanent. Drag a file onto a card to replace it." />
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
                          arrival={arrivalFor(site)}
                          onSettled={arrivals.settle}
                        />
                      ))}
                    </ul>
                  </section>
                ) : null}

                {noResults ? (
                  <div className="flex flex-col items-center gap-2 rounded-[var(--r-lg)] border border-dashed border-border px-6 py-12 text-center">
                    <p className="font-display text-xl font-semibold tracking-[-0.02em] text-text">
                      {noSearchResults(query.trim())}
                    </p>
                    <p className="text-[15px] text-text-secondary">Try another word, or clear the search.</p>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setQuery("")}
                      className="mt-2 font-body font-medium"
                    >
                      Clear search
                    </Button>
                  </div>
                ) : null}
              </>
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

function SectionHeading({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="font-mono text-xs font-medium uppercase tracking-[0.08em] text-text">{title}</h2>
      <span className="text-sm text-text-secondary">{note}</span>
    </div>
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
