"use client";

/**
 * The swap chooser — E06 task 007.
 *
 * ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ────────────────────────────
 * `POST /api/sites/swap` already exists, is origin-gated, and runs `swapKept` in
 * ONE Postgres transaction that refuses `demote === keep`. This file builds no
 * endpoint, changes no server logic and adds no second atomicity mechanism. It
 * is the moment before that write: an account at `KEPT_PAGE_LIMIT` presses Keep
 * on a draft and has to decide which of its permanent pages stops being
 * permanent.
 *
 * ── THE WARNING NAMES BOTH PAGES ─────────────────────────────────────────────
 * "Swap a page?" is not a warning. The consequence sentence comes from
 * `swapConsequence` in `lib/sites/display.ts` — both names, and the clock in
 * `DRAFT_TTL_DAYS` terms rather than a typed `7`, because demote sets a FRESH
 * clock and the day that constant moves this sentence must move with it. It
 * lives in `lib/` so the unit suite can assert it; a copy rule that cannot be
 * run is a copy rule that gets edited back to a literal.
 *
 * ── `demote === keep` IS UNCONSTRUCTABLE HERE ────────────────────────────────
 * The page being kept is never in the candidate list — the caller passes it as
 * `keepTarget` and the list is filtered on its id. The route's 400 is therefore
 * unreachable from this UI, which is exactly why it is surfaced verbatim rather
 * than swallowed if it ever arrives: it would mean this screen and the database
 * disagree about which page is which, and hiding that would be the worst
 * possible response.
 *
 * ── ONE REQUEST, BOTH CARDS ──────────────────────────────────────────────────
 * `SwapResult` carries both halves and a post-swap `KeptQuota` on each, so
 * `onSwapped` hands the caller everything the two cards and the header quota
 * need. No refetch, no `router.refresh()`, and no optimistic guess that can
 * disagree with the transaction that just committed.
 *
 * ── ONE COMPONENT, TWO SURFACES ──────────────────────────────────────────────
 * The dashboard card mounts it (task 007) and `/site/[slug]` mounts the same one
 * (task 008). It therefore owns no data fetching and no routing: everything it
 * knows arrives as props and everything it learns leaves through `onSwapped`.
 *
 * DESIGNED FROM TOKENS, NOT IMPORTED. `kept Dashboard.dc.html` was unavailable
 * to this task; the dialog is composed from `globals.css`'s tokens in the house
 * language — hairline rules, mono meta-labels, accent reserved for the one row
 * that has been chosen. A later reconciliation pass against the export is a
 * known follow-up.
 */
import { useEffect, useRef, useState } from "react";

import { type KeptQuota, type SiteStatus, type SwapResult } from "@kept/shared";

import { AT_CAP_NOTE, KeptQuotaChip } from "@/components/kept/kept-quota";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { managementRefusal, swapConsequence, swapRefusal } from "@/lib/sites/display";
import { swapPages } from "@/lib/sites/owner-client";
import { cn } from "@/lib/utils";

/**
 * One page as the chooser needs it. Exported so the dashboard and the detail
 * screen build the SAME shape rather than two near-identical ones — the second
 * of which would be the one that forgets `status` and starts offering a
 * quarantined page as a swap target.
 */
export interface SwapPage {
  id: string;
  /** `title ?? slug`, from `pageName`. Never assembled again here. */
  name: string;
  slug: string;
  liveUrl: string;
  status: SiteStatus;
}

/** The slug is the part that is theirs; the suffix is ours. No hostname literal. */
function hostSuffixOf(page: SwapPage): string {
  return new URL(page.liveUrl).host.slice(page.slug.length);
}

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
  const [demoteId, setDemoteId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  // A dialog reopened after a failure must not still be showing the failure, and
  // a second swap must not inherit the first one's selection.
  useEffect(() => {
    if (!open) return;
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

  const options = candidates.filter((page) => page.id !== keepTarget.id);
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
                {AT_CAP_NOTE} Choose which page becomes a draft again;{" "}
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
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
          </DialogFooter>
        ) : (
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
                // one answer, and the browser owns all of that. Re-implementing it
                // on divs is how a chooser ends up unusable from a keyboard.
                className="min-w-0"
                disabled={pending}
              >
                <legend className="mono-label mb-2 text-[11px] text-text-muted">
                  Which page becomes a draft?
                </legend>

                <div className="max-h-[min(44vh,19rem)] space-y-2 overflow-y-auto pr-1">
                  {options.map((page) => (
                    <CandidateRow
                      key={page.id}
                      page={page}
                      selected={page.id === demoteId}
                      onSelect={() => setDemoteId(page.id)}
                    />
                  ))}
                </div>
              </fieldset>
            )}

            <p
              data-testid="swap-consequence"
              className={cn(
                "rounded-[var(--r-md)] border px-4 py-3 text-sm leading-relaxed",
                chosen
                  ? "border-accent bg-accent-soft text-text"
                  : "border-border bg-sunken text-text-muted",
              )}
            >
              {chosen
                ? swapConsequence(chosen.name, keepTarget.name)
                : "Pick a page above and this will say exactly what changes."}
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
                data-testid="swap-cancel"
                disabled={pending}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                data-testid="swap-confirm"
                // Disabled until a page is chosen, which is also why focus can
                // never land here first: the consequential control is inert until
                // the consequence on screen is true.
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
        {refusal ? (
          <span className="mt-1.5 block text-xs leading-relaxed text-text-secondary">
            {refusal}
          </span>
        ) : null}
      </span>
    </label>
  );
}
