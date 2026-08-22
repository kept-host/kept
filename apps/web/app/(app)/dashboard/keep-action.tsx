"use client";

/**
 * The Keep button on a draft card, and the chooser behind it — E06 task 007.
 *
 * ── THE ONE BRANCH THIS COMPONENT EXISTS FOR ─────────────────────────────────
 * Under the cap, Keep just keeps: one `POST /api/sites/:id/keep`, the card flips
 * to permanent, the header quota ticks. At the cap there is a decision to make
 * first — which kept page stops being permanent — and the chooser opens INSTEAD
 * of a request being sent. Keeping at the cap is not an error (the route answers
 * 200 with `owned_draft`), it is simply a write with nothing to gain: the page
 * is already owned and already on this wall, so the only thing the call could
 * change is nothing.
 *
 * The `owned_draft` branch below is therefore not the normal at-cap path. It is
 * the race: a slot that looked free when this card rendered was taken in another
 * tab before the click landed. The response's `quota` is the authority that
 * settles it, and the chooser opens with the number the server just gave us
 * rather than the one this screen was rendered with.
 *
 * ── WHY THE BUTTON DOES NOT VANISH ON A FLAGGED PAGE ─────────────────────────
 * `managementRefusal` already explains, on the card, why a `quarantined` or
 * `under_review` page cannot be kept. The button stays, disabled, pointed at
 * that sentence with `aria-describedby` — refuse with a reason, never hide, for
 * the reason written above `managementRefusal` itself.
 */
import { useRef, useState } from "react";
import { Bookmark } from "lucide-react";

import type { SwapResult } from "@kept/shared";

import { SwapDialog } from "@/components/kept/swap-dialog";
import { Button } from "@/components/ui/button";
import { managementRefusal, swapConsequence } from "@/lib/sites/display";
import { keepPage } from "@/lib/sites/owner-client";

import {
  useApplyResults,
  useKeptQuota,
  useSiteClock,
  useSwapCandidates,
  type DashboardPage,
} from "./keep-state";

export function KeepAction({
  site,
  /** The id of the card's refusal sentence, when it has one. */
  refusalId,
}: {
  site: DashboardPage;
  refusalId: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const abort = useRef<AbortController | null>(null);

  const quota = useKeptQuota();
  const candidates = useSwapCandidates();
  const { applyKeep, applySwap } = useApplyResults();
  const clock = useSiteClock(
    site.id,
    site.expiresAt === null ? null : new Date(site.expiresAt),
  );

  const refusal = managementRefusal(site.status);

  // Kept in this session: there is nothing left to keep, and the card's own chip
  // and dot have already said so. Only the announcement stays, so the outcome is
  // still on its way to a screen reader when the button that caused it has gone.
  if (clock === null) {
    return (
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    );
  }

  function onSwapped(result: SwapResult) {
    const demoted = candidates.find((page) => page.id === result.demoted.siteId);
    applySwap(result);
    setAnnouncement(swapConsequence(demoted?.name ?? result.demoted.slug, site.name));
  }

  async function keep() {
    if (pending) return;

    // At the cap the decision comes before the write. No request is sent.
    if (quota.remaining === 0) {
      setError(null);
      setOpen(true);
      return;
    }

    setPending(true);
    setError(null);

    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    const outcome = await keepPage(site.id, controller.signal);
    setPending(false);

    if (!outcome.ok) {
      setError(outcome.error.message);
      return;
    }

    applyKeep(outcome.result);
    if (outcome.result.outcome === "owned_draft") {
      // The race described in the header — the account filled up under us.
      setOpen(true);
      return;
    }
    setAnnouncement(`${site.name} is kept for good.`);
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        data-testid="keep-button"
        className="px-2.5 text-xs"
        disabled={refusal !== null || pending}
        aria-describedby={refusal ? refusalId : undefined}
        onClick={keep}
      >
        <Bookmark aria-hidden="true" />
        {pending ? "Keeping…" : "Keep"}
        <span className="sr-only"> {site.slug} forever</span>
      </Button>

      {error ? (
        <p
          role="alert"
          data-testid="keep-error"
          className="max-w-[22ch] text-right text-[11px] leading-relaxed text-danger"
        >
          {error}
        </p>
      ) : null}

      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>

      <SwapDialog
        open={open}
        onOpenChange={setOpen}
        keepTarget={site}
        candidates={candidates}
        quota={quota}
        onSwapped={onSwapped}
      />
    </div>
  );
}
