"use client";

/**
 * The swap chooser — E06 tasks 007 and 011 (PRD §5.3, AC12).
 *
 * ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ────────────────────────────
 * `POST /api/sites/swap` already exists, is origin-gated, and runs `swapKept` in
 * ONE Postgres transaction that refuses `demote === keep`. This file builds no
 * endpoint and adds no second atomicity mechanism. It is the moment before that
 * write: an account at its kept limit presses Swap… on a draft and decides which
 * of its permanent pages stops being permanent.
 *
 * ── PICK → CONFIRM → DONE (PRD §9.2) ─────────────────────────────────────────
 * 1. **Pick.** The kept pages, LEAST VISITED FIRST (the `VISITS_RECENT_DAYS`
 *    sum; a page with no visit data yet counts as none) — the page that matters
 *    least to visitors is the natural one to give back. Searchable by name and
 *    address, because an account at its limit has a long list.
 * 2. **Confirm.** The demote warning, naming both pages: `swapConsequence` in
 *    `lib/sites/display.ts`, which puts the clock in `DRAFT_TTL_DAYS` terms
 *    because demote sets a FRESH clock. Nothing is written before this step.
 * 3. **Done.** `onSwapped` hands the caller both halves; the caller toasts
 *    "Swapped." and calls `router.refresh()` (PRD §5.1: no live updates), so
 *    both cards move with the next server render.
 *
 * ── `demote === keep` IS UNCONSTRUCTABLE HERE ────────────────────────────────
 * The page being kept is never in the candidate list — the caller passes it as
 * `keepTarget` and the list is filtered on its id. The route's 400 is therefore
 * unreachable from this UI, which is exactly why it is surfaced verbatim rather
 * than swallowed if it ever arrives.
 *
 * ── ONE COMPONENT, TWO SURFACES ──────────────────────────────────────────────
 * The Pages home's draft cards mount it (task 011) and the page-detail screen
 * mounts the same one (`/site/[id]`, task 012). It owns no data fetching and no
 * routing: everything it knows arrives as props and everything it learns leaves
 * through `onSwapped`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

import { type KeptQuota, type SiteStatus, type SwapResult } from "@kept/shared";

import { atCapNote, KeptQuotaChip } from "@/components/kept/kept-quota";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  managementRefusal,
  swapConsequence,
  swapRefusal,
  visitsLabel,
} from "@/lib/sites/display";
import { swapPages } from "@/lib/sites/owner-client";
import { cn } from "@/lib/utils";

/**
 * One page as the chooser needs it. Exported so the home and the detail screen
 * build the SAME shape rather than two near-identical ones — the second of
 * which would be the one that forgets `status` and starts offering a
 * quarantined page as a swap target.
 */
export interface SwapPage {
  id: string;
  /** `title ?? slug`, from `pageName`. Never assembled again here. */
  name: string;
  slug: string;
  liveUrl: string;
  status: SiteStatus;
  /** The `VISITS_RECENT_DAYS` sum; `null`/absent when there is no data yet. */
  visits?: number | null;
}

/** The slug is the part that is theirs; the suffix is ours. No hostname literal. */
function hostSuffixOf(page: SwapPage): string {
  return new URL(page.liveUrl).host.slice(page.slug.length);
}

/** Least visited first; no data counts as no visits. Stable for ties. */
function leastVisitedFirst(pages: SwapPage[]): SwapPage[] {
  return [...pages].sort((a, b) => (a.visits ?? 0) - (b.visits ?? 0));
}

type Step = "pick" | "confirm";

export function SwapDialog({
  open,
  onOpenChange,
  keepTarget,
  candidates,
  quota,
  onSwapped,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The draft this flow started from. The `keep` half, and never selectable. */
  keepTarget: SwapPage;
  /**
   * The account's kept pages. The caller may pass the target too — it is
   * filtered out here, so no call site can forget to.
   */
  candidates: SwapPage[];
  /** The allowance as it stands now, rendered through task 002's one component. */
  quota: KeptQuota;
  /** Both halves of the committed transaction. Called once, on success. */
  onSwapped: (result: SwapResult) => void;
}) {
  const [step, setStep] = useState<Step>("pick");
  const [query, setQuery] = useState("");
  const [demoteId, setDemoteId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  // A dialog reopened after a failure must not still be showing the failure, and
  // a second swap must not inherit the first one's selection.
  useEffect(() => {
    if (!open) return;
    setStep("pick");
    setQuery("");
    setDemoteId(null);
    setError(null);
  }, [open]);

  // The request outlives the dialog only if the whole screen goes away.
  useEffect(() => {
    return () => abort.current?.abort();
  }, []);

  // Refusing to keep a flagged page is the caller's job too, but this component
  // is mounted from two surfaces and must not depend on both remembering.
  const targetRefusal = managementRefusal(keepTarget.status);

  const options = useMemo(
    () => leastVisitedFirst(candidates.filter((page) => page.id !== keepTarget.id)),
    [candidates, keepTarget.id],
  );
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? options.filter(
        (page) =>
          page.name.toLowerCase().includes(needle) || page.slug.includes(needle),
      )
    : options;
  const chosen = options.find((page) => page.id === demoteId) ?? null;

  /**
   * ⚠️ CLOSING IS REFUSED WHILE THE TRANSACTION IS IN FLIGHT. Escape, the
   * overlay and the close button all funnel through this one handler, so
   * guarding it once covers all three. Aborting a POST that may already have
   * committed would leave the screen unable to say which pages are kept.
   */
  function requestOpenChange(next: boolean) {
    if (pending && !next) return;
    onOpenChange(next);
  }

  async function confirm() {
    if (!chosen || pending) return;
    setPending(true);
    setError(null);

    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    const outcome = await swapPages(chosen.id, keepTarget.id, controller.signal);
    setPending(false);

    if (!outcome.ok) {
      setError(outcome.error.message);
      return;
    }
    onSwapped(outcome.result);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={requestOpenChange}>
      <DialogContent
        data-testid="swap-dialog"
        className="max-w-xl"
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (pending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <p className="mono-label text-[11px] text-text-muted">Keep this page</p>
          <DialogTitle>Swap a kept page</DialogTitle>
          <DialogDescription>
            {targetRefusal ?? (
              <>
                {atCapNote(quota.limit)} Choose which page becomes a draft again;{" "}
                <span className="font-medium text-text">{keepTarget.name}</span> takes
                its place.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {targetRefusal ? (
          // Nothing to choose: the page this flow started from cannot be kept at
          // all, so offering a list of pages to sacrifice for it would be a trap.
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        ) : step === "pick" ? (
          <>
            <KeptQuotaChip quota={quota} />

            {options.length === 0 ? (
              <p className="rounded-[var(--r-md)] border border-border bg-sunken px-4 py-3 text-sm leading-relaxed text-text-secondary">
                There is no other page to swap out. Keep this one once a slot frees up,
                or go Pro for more room.
              </p>
            ) : (
              <fieldset
                // A native radio group: arrow keys move within it, one name means
                // one answer, and the browser owns all of that.
                className="min-w-0"
              >
                <legend className="mono-label mb-2 text-[11px] text-text-muted">
                  Which page becomes a draft? Least visited first.
                </legend>

                <label className="mb-2 flex h-10 items-center gap-2 rounded-[var(--r-sm)] border border-border bg-surface px-3 text-text-secondary focus-within:border-accent focus-within:ring-2 focus-within:ring-accent">
                  <Search aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.5} />
                  <input
                    type="search"
                    data-testid="swap-search"
                    aria-label="Search your kept pages"
                    placeholder="Search your kept pages"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="h-7 min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-muted"
                  />
                </label>

                <div className="max-h-[min(44vh,19rem)] space-y-2 overflow-y-auto pr-1">
                  {shown.map((page) => (
                    <CandidateRow
                      key={page.id}
                      page={page}
                      selected={page.id === demoteId}
                      onSelect={() => setDemoteId(page.id)}
                    />
                  ))}
                  {shown.length === 0 ? (
                    <p className="px-1 py-3 text-sm text-text-secondary">
                      No kept page matches &lsquo;{query.trim()}&rsquo;.
                    </p>
                  ) : null}
                </div>
              </fieldset>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                data-testid="swap-cancel"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                data-testid="swap-next"
                // Inert until a page is chosen: the next step names it.
                disabled={!chosen}
                onClick={() => setStep("confirm")}
              >
                Continue
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <p
              data-testid="swap-consequence"
              className="rounded-[var(--r-md)] border border-[color-mix(in_srgb,var(--warning)_45%,var(--surface))] bg-[color-mix(in_srgb,var(--warning)_14%,var(--surface))] px-4 py-3 text-sm leading-relaxed text-text"
            >
              {chosen ? swapConsequence(chosen.name, keepTarget.name) : null}
            </p>

            {error ? (
              // The route's own message, never flattened. `role="alert"` because
              // the failure arrives after the click and nothing else moves.
              <p
                role="alert"
                data-testid="swap-error"
                className="rounded-[var(--r-md)] border border-danger px-4 py-3 text-sm leading-relaxed text-danger"
              >
                {error}
              </p>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                data-testid="swap-back"
                disabled={pending}
                onClick={() => setStep("pick")}
              >
                Back
              </Button>
              <Button
                type="button"
                data-testid="swap-confirm"
                disabled={!chosen || pending}
                onClick={confirm}
              >
                {pending ? "Swapping…" : "Swap pages"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * One kept page, offered or refused.
 *
 * REFUSED ROWS ARE STILL LISTED. A page that is clockless but not `live` sits
 * under "Kept" on the wall and is the obvious thing to pick, so dropping it from
 * the list would read as the page having gone missing. It is shown, disabled,
 * and told why — `swapRefusal` owns the sentence.
 */
function CandidateRow({
  page,
  selected,
  onSelect,
}: {
  page: SwapPage;
  selected: boolean;
  onSelect: () => void;
}) {
  const refusal = swapRefusal(page.status);

  return (
    <label
      data-testid={`swap-candidate-${page.slug}`}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-[var(--r-md)] border p-3",
        "motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-[var(--ease-out)]",
        // The focus ring rides on the row, not on the 16px radio, because the row
        // is what a keyboard user is actually looking at.
        "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-surface",
        refusal
          ? "cursor-not-allowed border-border bg-sunken opacity-70"
          : selected
            ? "border-accent bg-accent-soft"
            : "border-border bg-surface hover:bg-sunken",
      )}
    >
      <input
        type="radio"
        name="swap-demote"
        value={page.id}
        checked={selected}
        disabled={refusal !== null}
        onChange={onSelect}
        // `accent-color` from the token, so the browser's own control is painted
        // in the product's violet without a hex or a hand-drawn replacement.
        className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
      />

      <span className="min-w-0 flex-1">
        <span className="block truncate font-display text-sm font-semibold text-text">
          {page.name}
        </span>
        <span className="mono-label mt-0.5 block truncate text-[11px] text-text-secondary">
          {page.slug}
          <span className="text-text-muted">{hostSuffixOf(page)}</span>
        </span>
        {page.visits !== null && page.visits !== undefined ? (
          <span className="mt-0.5 block font-mono text-[11px] text-text-secondary">
            {visitsLabel(page.visits)}
          </span>
        ) : null}
        {refusal ? (
          <span className="mt-1.5 block text-xs leading-relaxed text-text-secondary">
            {refusal}
          </span>
        ) : null}
      </span>
    </label>
  );
}
