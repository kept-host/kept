"use client";

/**
 * Keep, demote, download and delete — E06 task 008.
 *
 * ── EVERY WARNING COMES BEFORE ITS WRITE ─────────────────────────────────────
 * Demote and delete both open a confirmation whose body states the consequence
 * in full *before* anything is sent. The endpoints say the same from their own
 * side — `app/api/sites/[id]/demote/route.ts`: "the confirmation is the
 * caller's" — and a warning printed after the write is a receipt, not a warning.
 * The sentences are `demoteConsequence` and `DELETE_GRACE_NOTE`, both composed
 * from `@kept/shared` constants, so there is no `7` and no `30` in this file.
 *
 * ── THE CAP IS A BRANCH, NOT AN ERROR ────────────────────────────────────────
 * At `KEPT_PAGE_LIMIT` the Keep button opens task 007's chooser and sends
 * nothing; under it, one POST. The `owned_draft` branch below is the race where
 * a slot filled up in another tab between render and click — the route answers
 * HTTP 200 and the fresh `quota` on the response is the authority that settles
 * it. The chooser is `SwapDialog` itself, mounted from here exactly as the
 * dashboard card mounts it; there is no second copy of that flow.
 *
 * ── A FLAGGED PAGE REFUSES AND SAYS WHY ──────────────────────────────────────
 * `quarantined` / `under_review` disable keep, demote (and, elsewhere, rename
 * and replace) and point at the one sentence `managementRefusal` owns, through
 * `aria-describedby`. Nothing is hidden: controls that quietly vanish when a
 * page is flagged are indistinguishable from the page having been lost. Delete
 * and download stay available — they are how an owner ends or rescues a page
 * they cannot otherwise touch.
 *
 * ── NO SERVER ACTIONS ────────────────────────────────────────────────────────
 * Every mutation is a `fetch` through `lib/sites/owner-client.ts`, parsed with
 * the shared schemas. A server action here would be a second CSRF model on the
 * same four routes E05a already origin-gates, for no gain.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bookmark, Download, RotateCcw, Trash2 } from "lucide-react";

import type { KeptQuota, SwapResult } from "@kept/shared";

import { DELETE_GRACE_NOTE } from "@/components/kept/draft-chip";
import { KeptQuotaChip } from "@/components/kept/kept-quota";
import { SwapDialog, type SwapPage } from "@/components/kept/swap-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { demoteConsequence, managementRefusal } from "@/lib/sites/display";
import { deletePage, demotePage, keepPage } from "@/lib/sites/owner-client";

/** Which confirmation, if any, is open. Only ever one at a time. */
type Confirming = "none" | "demote" | "delete";

export function ActionsPanel({
  site,
  clock,
  quota,
  candidates,
  html,
  refusalId,
  onClock,
  onQuota,
}: {
  site: SwapPage;
  /** The page's clock as it stands right now. `null` ⇒ kept. */
  clock: Date | null;
  quota: KeptQuota;
  candidates: SwapPage[];
  /** The page's bytes when they could be read, for the download. */
  html: string | null;
  /** The id of the flagged-page explanation, when there is one. */
  refusalId?: string;
  onClock: (next: Date | null) => void;
  onQuota: (next: KeptQuota) => void;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<Confirming>("none");
  const [swapOpen, setSwapOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const abort = useRef<AbortController | null>(null);

  // An in-flight write outliving this screen would resolve into a `setState` on
  // something that is gone. The write itself is not cancelled — the server
  // finishes what it started — only this screen's interest in the answer.
  useEffect(() => {
    return () => abort.current?.abort();
  }, []);

  const refusal = managementRefusal(site.status);
  const isDraft = clock !== null;

  function nextController(): AbortController {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    return controller;
  }

  /**
   * Re-read the server tree after a write that changed which pages are kept.
   *
   * ⚠️ NOT A REFETCH OF THE ANSWER — the clock and the quota already came off
   * the committed transaction and are applied above, from the response, exactly
   * as the acceptance rule requires. What goes stale is `candidates`: the swap
   * chooser's list is *other* rows this screen only knows about because the
   * server told it once, and after a keep or a demote that list is a page out of
   * date. The local state is the authority and survives the refresh untouched;
   * this only refreshes what nothing here could have known.
   */
  function resync() {
    router.refresh();
  }

  async function keep() {
    if (pending) return;

    // At the cap the decision comes before the write. No request is sent.
    if (quota.remaining === 0) {
      setError(null);
      setSwapOpen(true);
      return;
    }

    setPending(true);
    setError(null);
    const outcome = await keepPage(site.id, nextController().signal);
    setPending(false);

    if (!outcome.ok) {
      setError(outcome.error.message);
      return;
    }

    onQuota(outcome.result.quota);
    if (outcome.result.outcome === "owned_draft") {
      // The race described in the header — the account filled up under us. The
      // page keeps its clock; the response's quota is what the chooser opens on.
      onClock(new Date(outcome.result.expiresAt));
      setSwapOpen(true);
      return;
    }
    onClock(null);
    setAnnouncement(`${site.name} is kept for good.`);
    resync();
  }

  async function demote() {
    if (pending) return;
    setPending(true);
    setError(null);
    const outcome = await demotePage(site.id, nextController().signal);
    setPending(false);

    if (!outcome.ok) {
      setError(outcome.error.message);
      return;
    }
    setConfirming("none");
    onClock(new Date(outcome.result.expiresAt));
    onQuota(outcome.result.quota);
    setAnnouncement(demoteConsequence(site.name));
    resync();
  }

  async function remove() {
    if (pending) return;
    setPending(true);
    setError(null);
    const outcome = await deletePage(site.id, nextController().signal);

    if (!outcome.ok) {
      setPending(false);
      setError(outcome.error.message);
      return;
    }
    // Deliberately NOT clearing `pending`: this screen is about to be replaced,
    // and re-enabling a delete button on a page that no longer serves would
    // invite a second call that can only 404. `replace` rather than `push` for
    // the same reason — Back must not return to a dead management screen.
    router.replace("/dashboard");
  }

  function onSwapped(result: SwapResult) {
    const demoted = candidates.find((page) => page.id === result.demoted.siteId);
    onClock(null);
    onQuota(result.kept.quota);
    setAnnouncement(
      `${site.name} is kept for good. ${demoteConsequence(demoted?.name ?? result.demoted.slug)}`,
    );
    resync();
  }

  return (
    <section className="rounded-[var(--r-lg)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <h2 className="font-display text-base font-semibold text-text">Manage</h2>

      <div className="mt-4">
        <KeptQuotaChip quota={quota} />
      </div>

      <div className="mt-4 flex flex-col gap-2">
        {isDraft ? (
          <Button
            type="button"
            data-testid="keep-button"
            disabled={refusal !== null || pending}
            aria-describedby={refusal ? refusalId : undefined}
            onClick={keep}
          >
            <Bookmark aria-hidden="true" />
            {pending ? "Keeping…" : "Keep forever"}
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            data-testid="demote-button"
            disabled={refusal !== null || pending}
            aria-describedby={refusal ? refusalId : undefined}
            onClick={() => {
              setError(null);
              setConfirming("demote");
            }}
          >
            <RotateCcw aria-hidden="true" />
            Make it a draft again
          </Button>
        )}

        {/* Bytes this screen already read, handed back as a file. Present only
            when they could be read at all — an offer that silently fails is
            worse than no offer, and the preview's own notice above has already
            explained the absence. */}
        {html !== null ? (
          <DownloadButton html={html} slug={site.slug} />
        ) : null}

        <Button
          type="button"
          variant="ghost"
          data-testid="delete-button"
          disabled={pending}
          onClick={() => {
            setError(null);
            setConfirming("delete");
          }}
          className="text-danger hover:bg-sunken hover:text-danger"
        >
          <Trash2 aria-hidden="true" />
          Delete this page
        </Button>
      </div>

      {error ? (
        <p
          role="alert"
          data-testid="manage-error"
          className="mt-3 text-xs leading-relaxed text-danger"
        >
          {error}
        </p>
      ) : null}

      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>

      {/* ── Demote: the consequence, then the button that causes it ───────── */}
      <ConfirmDialog
        open={confirming === "demote"}
        onOpenChange={(open) => !pending && setConfirming(open ? "demote" : "none")}
        eyebrow="Kept page"
        title="Put this page back on a clock?"
        description={demoteConsequence(site.name)}
        confirmLabel={pending ? "Changing…" : "Make it a draft"}
        testId="demote-dialog"
        pending={pending}
        onConfirm={demote}
      />

      {/* ── Delete: what stops now, and what survives ─────────────────────── */}
      <ConfirmDialog
        open={confirming === "delete"}
        onOpenChange={(open) => !pending && setConfirming(open ? "delete" : "none")}
        eyebrow="Delete"
        title={`Delete ${site.name}?`}
        description={`It stops serving at ${site.liveUrl} straight away, and anyone following an existing link will find nothing there. ${DELETE_GRACE_NOTE}`}
        confirmLabel={pending ? "Deleting…" : "Delete this page"}
        confirmVariant="destructive"
        testId="delete-dialog"
        pending={pending}
        onConfirm={remove}
      />

      {/* Task 007's chooser, mounted — not a copy of it. */}
      <SwapDialog
        open={swapOpen}
        onOpenChange={setSwapOpen}
        keepTarget={site}
        candidates={candidates}
        quota={quota}
        onSwapped={onSwapped}
      />
    </section>
  );
}

/**
 * A consequence, a way out, and one button that does the thing.
 *
 * ⚠️ CLOSING IS REFUSED WHILE THE WRITE IS IN FLIGHT, for `SwapDialog`'s reason:
 * Escape, the overlay and the close button all funnel through one handler, and
 * abandoning a request that may already have committed leaves the screen unable
 * to say what happened.
 */
function ConfirmDialog({
  open,
  onOpenChange,
  eyebrow,
  title,
  description,
  confirmLabel,
  confirmVariant = "primary",
  testId,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eyebrow: string;
  title: string;
  description: string;
  confirmLabel: string;
  confirmVariant?: React.ComponentProps<typeof Button>["variant"];
  testId: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        data-testid={testId}
        className="max-w-lg"
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
          <p className="mono-label text-[11px] text-text-muted">{eyebrow}</p>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-testid={`${testId}-confirm`}
            variant={confirmVariant}
            disabled={pending}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The page's own file, saved.
 *
 * ⚠️ THE ONE PLACE A FLAGGED PAGE'S BYTES ARE STILL REACHABLE. A `quarantined`
 * page is not being served, so "Open" leads nowhere and this is how its owner
 * gets their work back. It is therefore not gated on status.
 *
 * A `Blob` and an object URL rather than a `data:` URL: object URLs are the
 * portable path for a download of this size, and the URL is revoked on the next
 * macrotask (the click has to happen first) with the timer cleared on unmount,
 * so neither the URL nor the timeout outlives the screen.
 */
function DownloadButton({ html, slug }: { html: string; slug: string }) {
  const revokeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (revokeTimer.current) clearTimeout(revokeTimer.current);
    };
  }, []);

  function download() {
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${slug}.html`;
    anchor.click();

    if (revokeTimer.current) clearTimeout(revokeTimer.current);
    revokeTimer.current = setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <Button type="button" variant="secondary" onClick={download}>
      <Download aria-hidden="true" />
      Download the file
      <span className="sr-only"> for {slug}</span>
    </Button>
  );
}
