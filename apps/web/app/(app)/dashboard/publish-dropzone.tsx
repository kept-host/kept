"use client";

/**
 * Publish a page from the dashboard — E06 task 009.
 *
 * ── ONE ROUTE, AND IT IS NOT THE KEYLESS ONE ─────────────────────────────────
 * `POST /api/sites` through `publishOwnedHtml`. `POST /api/publish` mints an
 * anonymous bearer token and leaves `owner_id` null; sending a signed-in user
 * down it would hand their browser a second authority for a page their account
 * already owns and route them through the endpoint E07's governors exist to
 * throttle. Epic decision **D1**.
 *
 * ── THE CAP DEGRADES, IT NEVER ERRORS ────────────────────────────────────────
 * At the account's kept limit the route answers **HTTP 200** with `owned_draft`: the
 * page published, it is serving right now, the account owns it, and it carries a
 * clock. So the at-cap branch below is painted as a *result*, in the accent —
 * never in `--danger`, never with a failure verb — and it offers the concrete
 * way out, which is task 007's chooser mounted here rather than a sentence
 * telling somebody to go and find it. The prose route out (`atCapNote`, which
 * also names Pro) is already on screen and permanent: it is the header's
 * `LiveKeptQuota note`, from the same component and the same number. Reprinting
 * it here would be two copies of one sentence three inches apart.
 *
 * ── THREE WAYS IN, ONE OF THEM WITHOUT A MOUSE ───────────────────────────────
 * Drag a file anywhere on the screen, choose one from the file picker, or paste
 * markup with ⌘V. The picker is a real `<input type="file">` behind a real
 * `<button>` — it focuses, it activates on Enter and Space, and it does
 * everything the drag path does. A drop zone that only accepted drags would be
 * a control half this product's users could not reach.
 *
 * ── WHY THE LISTENERS ARE ON THE WINDOW ──────────────────────────────────────
 * A file dropped on the page *background* is not a no-op: without a handler the
 * browser navigates to the file and the dashboard is simply gone. So the window
 * is where the drop is caught and `preventDefault`ed. That listener must not
 * also swallow a drop aimed at a card, which owns its own replace — hence
 * `isReplaceTarget`, the one shared coordinate between this file and
 * `card-replace.tsx`. Precedence is decided by where the pointer was, once, in
 * one place.
 *
 * ── WHAT WAS REUSED, AND WHY THE DRAG HANDLING IS STILL HERE ────────────────
 * The two existing drop surfaces were read first. `components/kept/kept-engine.ts`
 * is E01's imperative hero choreography, wired to `KeptLanding.tsx`'s own DOM and
 * its publish phases — it is not a component and cannot be mounted. E04's
 * `app/p/[anonToken]/replace-dropzone.tsx` is bound to a bearer token and the
 * anon manage client. Neither is a reusable React drop primitive, and the one
 * that *is* — task 006's `owner-replace-drop.tsx` — posts to the replace route
 * and is owned by another task, so it may be mounted (it is, on every card) but
 * not rewritten into a shared shell.
 *
 * What is genuinely shared is the part that would actually drift: the pre-flight
 * (`checkPageFile` / `checkPageHtml` against `MAX_PAGE_BYTES`), the error copy
 * (`publishErrorText`) and the "was this clipboard even meant for kept"
 * predicate (`LOOKS_LIKE_MARKUP`) — all four imported from
 * `lib/publish/client.ts`, the module E01 and E04 already read them from. The
 * drag *listeners* below are not duplicated logic; they are this screen's
 * window-level precedence rule, which exists nowhere else because no other
 * screen has a wall of competing drop targets.
 *
 * DESIGNED FROM TOKENS, NOT IMPORTED. No Claude Design export exists for this
 * card; it extends the dashboard's own language — dashed hairline, mono eyebrow,
 * warm surface, accent on engagement. A reconciliation pass against the export
 * is a known follow-up, recorded in the task.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Upload } from "lucide-react";

import type { OwnedPublishResult, SwapResult } from "@kept/shared";

import { CopyLinkButton } from "@/components/kept/live-url";
import { SwapDialog } from "@/components/kept/swap-dialog";
import { Button } from "@/components/ui/button";
import {
  checkPageFile,
  checkPageHtml,
  LOOKS_LIKE_MARKUP,
  publishErrorText,
} from "@/lib/publish/client";
import { atCapPublishNotice, pageName, publishedKeptNotice } from "@/lib/sites/display";
import { publishOwnedHtml } from "@/lib/sites/owner-client";
import { cn } from "@/lib/utils";

import { isReplaceTarget } from "./card-replace";
import {
  LiveKeptQuota,
  useApplyResults,
  useKeptQuota,
  useSwapCandidates,
} from "./keep-state";

/** What the drop zone is doing right now. Every one of them is on screen. */
type Phase = "idle" | "reading" | "sending" | "done";

/** Whether a drag is carrying files at all, rather than selected text. */
function draggingFiles(transfer: DataTransfer | null): boolean {
  return transfer !== null && Array.from(transfer.types).includes("Files");
}

/**
 * Whether a paste landed somewhere that owns its own text.
 *
 * Without this, ⌘V inside the rename field on any other screen in this group
 * would try to publish a slug. The dashboard has no text inputs today; the check
 * is here because the day one arrives, nobody will remember this listener.
 */
function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])") !==
      null
  );
}

export function PublishDropzone({ className }: { className?: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OwnedPublishResult | null>(null);
  const [swapOpen, setSwapOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abort = useRef<AbortController | null>(null);
  const headingId = useId();

  const { applyPublish, applySwap } = useApplyResults();
  const candidates = useSwapCandidates();
  // The live allowance, which `applyPublish` has already set from the response
  // this card is showing. The chooser and the header read the same one.
  const quota = useKeptQuota();
  const busy = phase === "reading" || phase === "sending";

  useEffect(() => {
    // An in-flight publish outliving this screen would resolve into a `setState`
    // on something that is gone. The write itself is not cancelled — the page is
    // published either way, and the next load of this screen shows it.
    return () => abort.current?.abort();
  }, []);

  const send = useCallback(
    async (html: string) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;

      setPhase("sending");
      const outcome = await publishOwnedHtml(html, controller.signal);
      if (controller.signal.aborted) return;

      if (!outcome.ok) {
        // Nothing on the wall moved, and the same file can be dropped again:
        // the input is cleared on every change, so `change` fires a second time
        // for the same choice.
        setPhase("idle");
        setError(publishErrorText(outcome.error));
        return;
      }

      setPhase("done");
      setResult(outcome.page);
      // The allowance, from the response that changed it — this is why the
      // number on this card and the number in the header cannot disagree.
      applyPublish(outcome.page);
      // And the card itself, which nothing here can render: size, version stamp
      // and thumbnail are all server-side, and the wall's two sections are a
      // server split on `expires_at`. See the note in `keep-state.tsx`.
      router.refresh();
    },
    [applyPublish, router],
  );

  /** A chosen or dropped file: the courtesy pre-flight, then the bytes. */
  const sendFile = useCallback(
    async (file: File) => {
      if (busy) return;
      setError(null);
      setResult(null);

      // Type, then size, against the SAME `MAX_PAGE_BYTES` the server enforces.
      // It saves an upload that was always going to be refused; it is not a
      // gate, and the server checks every byte again and is the only authority.
      const rejected = checkPageFile(file);
      if (rejected) {
        setPhase("idle");
        setError(publishErrorText(rejected));
        return;
      }

      setPhase("reading");
      let html: string;
      try {
        html = await file.text();
      } catch {
        setPhase("idle");
        setError("That file could not be read. Try choosing it again.");
        return;
      }
      await send(html);
    },
    [busy, send],
  );

  /** Pasted markup. Same limit, same authority, no file to read. */
  const sendHtml = useCallback(
    async (html: string) => {
      if (busy) return;
      setError(null);
      setResult(null);

      const rejected = checkPageHtml(html);
      if (rejected) {
        setPhase("idle");
        setError(publishErrorText(rejected));
        return;
      }
      await send(html);
    },
    [busy, send],
  );

  // ── The whole window is the drop target; a card gets first refusal ─────────
  useEffect(() => {
    function onDragOver(event: DragEvent) {
      if (!draggingFiles(event.dataTransfer)) return;
      // Required for `drop` to fire at all — and it is also what stops the
      // browser navigating away from the dashboard to the dropped file.
      event.preventDefault();
      setDragging(!isReplaceTarget(event.target));
    }

    function onDrop(event: DragEvent) {
      if (!draggingFiles(event.dataTransfer)) return;
      event.preventDefault();
      setDragging(false);
      // A card owns this one. Its own React handler has already taken it.
      if (isReplaceTarget(event.target)) return;
      const file = event.dataTransfer?.files.item(0) ?? null;
      if (file) void sendFile(file);
    }

    // `relatedTarget === null` is the drag leaving the window rather than moving
    // between two elements inside it, which fires constantly.
    function onDragLeave(event: DragEvent) {
      if (event.relatedTarget === null) setDragging(false);
    }

    function onDragEnd() {
      setDragging(false);
    }

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragend", onDragEnd);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragend", onDragEnd);
    };
  }, [sendFile]);

  // ── ⌘V anywhere that is not a text field ──────────────────────────────────
  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      if (isTextEntry(event.target)) return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      // `LOOKS_LIKE_MARKUP` is why pasting a sentence does not publish it. It
      // decides whether the clipboard was meant for kept at all, and validates
      // nothing — that is the server's job, on every byte.
      if (!LOOKS_LIKE_MARKUP.test(text)) return;
      event.preventDefault();
      void sendHtml(text);
    }

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [sendHtml]);

  const atCap = result !== null && result.outcome === "owned_draft";
  const name = result ? pageName(result) : "";

  return (
    <section
      aria-labelledby={headingId}
      data-testid="publish-dropzone"
      data-dragging={dragging ? "true" : undefined}
      className={cn(
        "rounded-[var(--r-xl)] border border-dashed border-border bg-surface p-6 shadow-[var(--shadow-sm)] md:p-7",
        "motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-[var(--ease-out)]",
        dragging && "border-accent bg-accent-soft",
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-5">
        <div className="min-w-0 max-w-[52ch]">
          <p className="mono-label text-[11px] text-text-muted">Publish</p>
          <h2
            id={headingId}
            className="mt-2 font-display text-xl font-semibold text-text"
          >
            {dragging ? "Let go and it is live" : "Drop a page in"}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">
            Drag an HTML file anywhere on this screen, choose one, or paste your
            markup. It is live at its own link the moment it lands, and it belongs
            to this account from its first byte.
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-start gap-3">
          <div className="flex items-center gap-3">
            <Upload aria-hidden="true" className="size-5 text-text-muted" />
            <input
              ref={inputRef}
              type="file"
              accept="text/html,.html,.htm,.xhtml"
              disabled={busy}
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.item(0) ?? null;
                // Cleared so choosing the SAME file twice fires `change` again —
                // a second attempt after a failure is the common case here.
                event.target.value = "";
                if (file) void sendFile(file);
              }}
            />
            <Button
              type="button"
              data-testid="publish-choose-file"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              {busy ? (
                <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />
              ) : phase === "done" ? (
                <Check aria-hidden="true" />
              ) : null}
              {phase === "reading"
                ? "Reading…"
                : phase === "sending"
                  ? "Publishing…"
                  : "Choose an HTML file"}
            </Button>
          </div>

          {/* The same allowance the header prints, from the same response. */}
          <LiveKeptQuota />
        </div>
      </div>

      {/* One polite live region for every outcome: what happened to a file
          somebody just dropped must never be visual-only. */}
      <p aria-live="polite" className="sr-only">
        {busy
          ? "Publishing your page."
          : error
            ? error
            : result
              ? atCap
                ? atCapPublishNotice(name)
                : publishedKeptNotice(name)
              : ""}
      </p>

      {error ? (
        <p
          role="alert"
          data-testid="publish-error"
          className="mt-5 border-t border-border pt-4 text-sm leading-relaxed text-danger"
        >
          {error}
        </p>
      ) : null}

      {result ? (
        <div
          data-testid={atCap ? "publish-at-cap-notice" : "publish-kept-notice"}
          className={cn(
            "mt-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-[var(--r-md)] border px-4 py-3",
            // Accent, not danger: at the cap the page published. Painting this
            // in the error colour is the "error toast wearing a friendly
            // colour" the task exists to prevent.
            atCap ? "border-accent bg-accent-soft" : "border-border bg-sunken",
          )}
        >
          <p className="max-w-[62ch] text-sm leading-relaxed text-text-secondary">
            {atCap ? atCapPublishNotice(name) : publishedKeptNotice(name)}
          </p>

          <div className="flex items-center gap-1">
            <CopyLinkButton
              liveUrl={result.liveUrl}
              label={
                <>
                  Copy
                  <span className="sr-only"> the link for {result.slug}</span>
                </>
              }
              variant="ghost"
              size="sm"
              className="px-2 text-xs"
            />
            {atCap ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="publish-swap-button"
                className="px-2.5 text-xs"
                onClick={() => setSwapOpen(true)}
              >
                Keep it instead…
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Task 007's chooser, mounted — not a copy of it. It only ever opens on
          the `owned_draft` branch, where the account is full and the decision
          is which kept page stops being permanent. */}
      {result && atCap ? (
        <SwapDialog
          open={swapOpen}
          onOpenChange={setSwapOpen}
          keepTarget={{
            id: result.siteId,
            name,
            slug: result.slug,
            liveUrl: result.liveUrl,
            // Just inserted by this request, and `publishOwnedSite` inserts
            // nothing else. E07 writes every other status and cannot have run.
            status: "live",
          }}
          candidates={candidates}
          quota={quota}
          onSwapped={(swapped: SwapResult) => {
            applySwap(swapped);
            // Both pages changed section, and the wall's split is server-side.
            router.refresh();
            // The notice above is now wrong about its own page: it is kept. Built
            // field by field rather than spread, so the draft branch's clock
            // cannot ride along into a shape that has no clock.
            setResult({
              outcome: "kept",
              siteId: result.siteId,
              slug: result.slug,
              quota: swapped.kept.quota,
              liveUrl: result.liveUrl,
              title: result.title,
            });
          }}
        />
      ) : null}
    </section>
  );
}
