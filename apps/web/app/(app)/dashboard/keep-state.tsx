"use client";

/**
 * What the dashboard knows about its own pages after a write — E06 task 007.
 *
 * ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────
 * A swap changes TWO pages and the header quota in one transaction, and the
 * acceptance rule is that all three update from the SINGLE `SwapResult` — no
 * refetch, no `router.refresh()`, no optimistic guess that can disagree with the
 * row that just committed. The cards are server-rendered and independent, so
 * there has to be one client-side place they all read from. This is it: seeded
 * by the server component, updated only by a parsed response, never by a
 * prediction made before the request.
 *
 * ── WHY IT IS A SECOND PROVIDER AND NOT MORE OF `ClockProvider` ──────────────
 * `ClockProvider` answers "what time is it", identically for every card, once
 * every thirty seconds. This answers "what does the server now say about this
 * page", per page, only when a mutation lands. Merging them would put a value
 * that changes on a timer and a value that changes on a write behind one
 * context, and every tick would re-render every consumer of both.
 *
 * ── WHAT IT IS NOT ───────────────────────────────────────────────────────────
 * Not a cache, not a store, not a place to put anything the server already
 * renders correctly. It holds exactly the two facts a keep or a swap changes —
 * a page's clock and the account's allowance — and everything else on a card
 * still comes from the server component that rendered it.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type {
  KeepResult,
  KeptQuota,
  OwnedPublishResult,
  SwapResult,
} from "@kept/shared";

import { KeptQuotaChip } from "@/components/kept/kept-quota";
import type { SwapPage } from "@/components/kept/swap-dialog";
import { pageName } from "@/lib/sites/display";

/**
 * One of the owner's pages, serialised for the browser.
 *
 * `expiresAt` is an ISO string rather than a `Date` because it crosses the RSC
 * boundary; every consumer that wants a `Date` builds one. It extends `SwapPage`
 * so the chooser's candidate list is this exact object, never a re-mapped copy
 * that could drift on `status`.
 */
export interface DashboardPage extends SwapPage {
  /** The draft clock. Set → draft; null → kept. The ONLY split there is. */
  expiresAt: string | null;
}

interface KeepState {
  quota: KeptQuota;
  pages: Record<string, DashboardPage>;
  applyKeep: (result: KeepResult) => void;
  applySwap: (result: SwapResult) => void;
  applyPublish: (result: OwnedPublishResult) => void;
}

const KeepStateContext = createContext<KeepState | null>(null);

function index(pages: DashboardPage[]): Record<string, DashboardPage> {
  return Object.fromEntries(pages.map((page) => [page.id, page]));
}

export function KeepStateProvider({
  initialPages,
  initialQuota,
  children,
}: {
  initialPages: DashboardPage[];
  initialQuota: KeptQuota;
  children: ReactNode;
}) {
  const [pages, setPages] = useState(() => index(initialPages));
  const [quota, setQuota] = useState(initialQuota);

  // ── THE SERVER WINS WHENEVER IT SPEAKS AGAIN (E06 task 009) ────────────────
  // A publish adds a row this screen has never seen, and no local state can
  // render its card — size, version stamp and thumbnail are all server-side. So
  // the drop-zone follows its `applyPublish` with a `router.refresh()`, and this
  // re-seeds from the RSC payload that comes back.
  //
  // It cannot clobber anything: these props only change when the server tree
  // re-renders, and a tree rendered *after* a keep or a swap committed already
  // contains it. Client state is the authority only for the window between a
  // response landing and the server being asked again.
  useEffect(() => {
    setPages(index(initialPages));
    setQuota(initialQuota);
  }, [initialPages, initialQuota]);

  /** Move one page's clock, leaving a page this screen does not know untouched. */
  const setClock = useCallback((siteId: string, expiresAt: string | null) => {
    setPages((prev) => {
      const page = prev[siteId];
      if (!page) return prev;
      return { ...prev, [siteId]: { ...page, expiresAt } };
    });
  }, []);

  const applyKeep = useCallback(
    (result: KeepResult) => {
      // `owned_draft` is a 200 and keeps its clock — the cap is a branch, not an
      // error, and this must not paint the page as kept because the call
      // succeeded.
      setClock(result.siteId, result.outcome === "kept" ? null : result.expiresAt);
      setQuota(result.quota);
    },
    [setClock],
  );

  const applySwap = useCallback(
    (result: SwapResult) => {
      setClock(result.demoted.siteId, result.demoted.expiresAt);
      setClock(result.kept.siteId, null);
      // Both halves carry the same post-transaction allowance; either would do.
      setQuota(result.kept.quota);
    },
    [setClock],
  );

  /**
   * A page that did not exist when this screen rendered — E06 task 009.
   *
   * Registered so the swap chooser's target does not wait for the refresh: a
   * publish that landed as a draft offers a swap immediately, and the page being
   * kept has to be a real entry. The allowance is NOT set here — `POST
   * /api/sites` answers `{ site }` and no quota (PRD §7), so the header and the
   * drop-zone repaint it together from the `router.refresh()` that follows every
   * publish, from one server read, and still cannot disagree.
   *
   * Everything comes off the response's `site`, which the route read back from
   * the row inside the transaction that wrote (or found) it.
   */
  const applyPublish = useCallback((result: OwnedPublishResult) => {
    const { site } = result;
    const page: DashboardPage = {
      id: site.id,
      name: pageName(site),
      slug: site.slug,
      liveUrl: site.liveUrl,
      status: site.status,
      expiresAt: site.expiresAt,
    };
    setPages((prev) => ({ ...prev, [page.id]: page }));
  }, []);

  const value = useMemo(
    () => ({ quota, pages, applyKeep, applySwap, applyPublish }),
    [quota, pages, applyKeep, applySwap, applyPublish],
  );

  return (
    <KeepStateContext.Provider value={value}>{children}</KeepStateContext.Provider>
  );
}

function useKeepState(): KeepState {
  const state = useContext(KeepStateContext);
  if (!state) {
    throw new Error(
      "This dashboard component must be rendered inside <KeepStateProvider>.",
    );
  }
  return state;
}

/**
 * A page's clock as it stands right now — the server's value until a keep or a
 * swap has moved it in this session.
 *
 * Tolerant of a missing provider ON PURPOSE: `SiteState` is also the shape
 * `/site/[slug]` will mount (task 008), which has one page and no wall, and a
 * component that threw there would make this file the dashboard's export.
 */
export function useSiteClock(siteId: string, serverValue: Date | null): Date | null {
  const state = useContext(KeepStateContext);
  const page = state?.pages[siteId];
  if (!state || !page) return serverValue;
  return page.expiresAt === null ? null : new Date(page.expiresAt);
}

/** The allowance, live. Every consumer reads the same number from the same write. */
export function useKeptQuota(): KeptQuota {
  return useKeepState().quota;
}

/**
 * The pages a swap may demote: everything clockless the account owns.
 *
 * The list is not filtered on status here — `swapRefusal` disables and explains
 * the ones that cannot free a slot, because a kept page that silently vanishes
 * from the chooser reads as a page that has gone missing.
 */
export function useSwapCandidates(): DashboardPage[] {
  const { pages } = useKeepState();
  return useMemo(
    () => Object.values(pages).filter((page) => page.expiresAt === null),
    [pages],
  );
}

/** Applying a parsed response is the ONLY way anything above changes. */
export function useApplyResults(): Pick<
  KeepState,
  "applyKeep" | "applySwap" | "applyPublish"
> {
  const { applyKeep, applySwap, applyPublish } = useKeepState();
  return { applyKeep, applySwap, applyPublish };
}

/**
 * The header's allowance chip, reading the live number.
 *
 * Task 002's component does the rendering; this only decides which `KeptQuota`
 * it gets. The server's value is the first one, and a swap's response is the
 * next — so the header and the chooser can never print different totals.
 */
export function LiveKeptQuota({
  note,
  className,
}: {
  note?: boolean;
  className?: string;
}) {
  return <KeptQuotaChip quota={useKeptQuota()} note={note} className={className} />;
}
