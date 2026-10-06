"use client";

/**
 * A draft's one action: **Keep**, or **Swap…** at the kept limit — PRD §5.3,
 * AC11 / AC12 (E06 tasks 007, 011). The draft card's, and the page-detail
 * header's (task 012), which sizes it up through `className`.
 *
 * ── BELOW THE LIMIT ──────────────────────────────────────────────────────────
 * One `POST /api/sites/:id/keep`; toast "Kept. It's permanent now."; then
 * `router.refresh()` and the card moves to the wall (PRD §5.1: no live
 * updates). An `expired` draft still inside its grace is kept the same way —
 * the route restores it (late keep, task 004). On the Pages home the move is
 * the keep moment (task 015): the caller's `onKept` fades the draft and brings
 * it in on the wall, and does the refresh itself.
 *
 * ── AT THE LIMIT ─────────────────────────────────────────────────────────────
 * The action reads **Swap…** (design call 4: not "Make room") and opens the
 * chooser without sending anything. If the account filled up between render
 * and click — another tab — the keep answers `409 at_kept_limit` (task 004),
 * and that code turns this card into Swap… and opens the chooser too.
 *
 * A flagged draft (`under_review`, `quarantined`) cannot be kept: the button
 * stays, disabled, with `managementRefusal`'s reason — refuse with a reason,
 * never hide.
 */
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { toast } from "sonner";

import type { KeptQuota } from "@kept/shared";

import { SwapDialog, type SwapPage } from "@/components/kept/swap-dialog";
import { Button } from "@/components/ui/button";
import { KEPT_TOAST, managementRefusal, SWAPPED_TOAST } from "@/lib/sites/display";
import { keepPage } from "@/lib/sites/owner-client";
import { cn } from "@/lib/utils";

export function KeepAction({
  page,
  atLimit,
  candidates,
  quota,
  onKept,
  className,
}: {
  /** The draft, as the chooser names it. */
  page: SwapPage;
  /** The account is at its kept limit (server's `KeptQuota`). */
  atLimit: boolean;
  /** The account's kept pages — the chooser's list. */
  candidates: SwapPage[];
  quota: KeptQuota;
  /** The draft is kept now (or swapped in) — the caller refreshes. Default: refresh. */
  onKept?: (id: string) => void;
  className?: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [pending, setPending] = useState(false);
  const [kept, setKept] = useState(false);
  const [filledUp, setFilledUp] = useState(false);
  const [swapOpen, setSwapOpen] = useState(false);
  const refusalId = useId();

  const refusal = managementRefusal(page.status);
  const swap = atLimit || filledUp;
  const host = new URL(page.liveUrl).host;
  const refresh = () => startTransition(() => router.refresh());
  const landed = () => (onKept ? onKept(page.id) : refresh());

  async function keep() {
    if (swap) {
      setSwapOpen(true);
      return;
    }
    setPending(true);
    const outcome = await keepPage(page.id);
    setPending(false);

    if (!outcome.ok) {
      if (outcome.error.code === "at_kept_limit") {
        setFilledUp(true);
        setSwapOpen(true);
        refresh();
        return;
      }
      toast.error(outcome.error.message, { description: host });
      return;
    }
    setKept(true);
    toast.success(KEPT_TOAST, { description: host });
    landed();
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant={swap || kept ? "secondary" : "primary"}
        data-testid="keep-button"
        disabled={refusal !== null || pending || kept}
        aria-describedby={refusal ? refusalId : undefined}
        title={refusal ?? undefined}
        onClick={keep}
        className={cn(
          "h-9 px-3.5 font-body font-medium",
          className,
          kept && "border-transparent bg-accent-soft text-accent-hover disabled:opacity-100",
        )}
      >
        {kept ? <Check aria-hidden="true" strokeWidth={1.5} /> : null}
        {kept ? "Kept" : pending ? "Keeping…" : swap ? "Swap…" : "Keep"}
        <span className="sr-only"> {page.name}</span>
      </Button>
      {refusal ? (
        <span id={refusalId} className="sr-only">
          {refusal}
        </span>
      ) : null}

      {swap ? (
        <SwapDialog
          open={swapOpen}
          onOpenChange={setSwapOpen}
          keepTarget={page}
          candidates={candidates}
          quota={quota}
          onSwapped={() => {
            setKept(true);
            toast.success(SWAPPED_TOAST, { description: host });
            landed();
          }}
        />
      ) : null}
    </>
  );
}
