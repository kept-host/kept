"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, Loader2, Upload } from "lucide-react";

import type { ReplaceResult, SiteStatus } from "@kept/shared";

import { Button } from "@/components/ui/button";
import { checkPageFile, publishErrorText } from "@/lib/publish/client";
import { managementRefusal } from "@/lib/sites/display";
import { replaceNotice, replacePage } from "@/lib/sites/owner-client";
import { cn } from "@/lib/utils";

import { REPLACE_CLOCK_NOTE } from "./draft-chip";

/**
 * Drop a new file on a page you already have — E06 task 006.
 *
 * ONE COMPONENT, TWO CALL SITES: the site detail screen (task 008) and the
 * dashboard card (task 009). They are different sizes and nothing else, which is
 * what `variant` is for. A second copy of this would be a second copy of the
 * file-read, the abort handling, the busy state and the error mapping — on the
 * one interaction where "nothing appeared to happen" is indistinguishable from
 * "your page was overwritten".
 *
 * ── WHAT IT PROMISES, AND WHAT IT MUST NOT ───────────────────────────────────
 * The URL does not change and the draft clock does not reset. Both are stated
 * rather than assumed: `REPLACE_CLOCK_NOTE` is shown on a draft because a person
 * re-dropping a file reasonably expects to have bought themselves another seven
 * days, and finding out otherwise from an expiry email is the worst possible
 * time. The sentence composes its number from `@kept/shared`; there is no `7`
 * here or anywhere below.
 *
 * ── A FLAGGED PAGE REFUSES AND SAYS WHY ──────────────────────────────────────
 * `quarantined` / `under_review` disable the control and print
 * `managementRefusal`'s sentence — the same one the card and the server's 409
 * use. The control is NOT hidden: a page whose affordances quietly vanish when
 * it is flagged is indistinguishable from data loss. E06 renders those states
 * and writes neither.
 *
 * ── RESOURCE HYGIENE ─────────────────────────────────────────────────────────
 * One `AbortController` per in-flight request, aborted on unmount, so a card
 * that scrolls out of a re-rendered list cannot resolve into a dead component.
 * `replacePage` never throws, including on abort.
 */

/** What the drop zone is doing right now. */
type Phase = "idle" | "reading" | "sending" | "done";

export function OwnerReplaceDrop({
  siteId,
  /** `title ?? slug` — names the control for assistive tech on a wall of cards. */
  name,
  /**
   * The page's draft clock, or `null` when it is kept. Drives one sentence: a
   * kept page has no clock to reassure anybody about.
   */
  expiresAt,
  /** The row's status. `quarantined` / `under_review` refuse with an explanation. */
  status,
  /** `card` is the compact form for the dashboard grid; `panel` is the detail screen. */
  variant = "panel",
  /**
   * Called with the parsed result once the new version is live. The caller owns
   * what happens next — repainting a card, refreshing a preview, `router.refresh`.
   */
  onReplaced,
  className,
}: {
  siteId: string;
  name: string;
  expiresAt: Date | null;
  status: SiteStatus;
  variant?: "panel" | "card";
  onReplaced?: (page: ReplaceResult) => void;
  className?: string;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputId = useId();

  const refusal = managementRefusal(status);
  const busy = phase === "reading" || phase === "sending";
  const disabled = refusal !== null || busy;

  useEffect(() => {
    // An in-flight replace outliving the component would resolve into a
    // `setState` on something that is gone. The write itself is not cancelled by
    // this — the server finishes what it started — only this screen's interest
    // in the answer.
    return () => abortRef.current?.abort();
  }, []);

  const send = useCallback(
    async (file: File) => {
      setError(null);
      setNotice(null);

      // The courtesy pre-flight: type, then size, against the SAME
      // `MAX_PAGE_BYTES` the server enforces. It saves a 5 MB upload that was
      // always going to be refused; it is not a gate, and the server checks
      // every byte again.
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

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setPhase("sending");
      const outcome = await replacePage(siteId, html, controller.signal);
      if (controller.signal.aborted) return;

      if (!outcome.ok) {
        setPhase("idle");
        setError(publishErrorText(outcome.error));
        return;
      }

      setPhase("done");
      setNotice(replaceNotice(outcome.page));
      onReplaced?.(outcome.page);
    },
    [onReplaced, siteId],
  );

  function onDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const file = event.dataTransfer.files.item(0);
    if (file) void send(file);
  }

  function onDragOver(event: React.DragEvent<HTMLDivElement>) {
    // Without this the browser navigates to the dropped file and the page the
    // user was managing is simply gone from under them.
    event.preventDefault();
    if (!disabled) setDragging(true);
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* The drop target is a decorated region around a real
          `<input type="file">` — the keyboard and assistive-tech path is that
          input and the button that opens it, both of which do everything the
          pointer path does. The div carries no role and no tabindex on purpose:
          a second, fake control here would be one more thing to keep accessible
          for no capability a person could not already reach. */}
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        data-dragging={dragging ? "true" : undefined}
        className={cn(
          "flex flex-col items-center gap-2 rounded-[var(--r-lg)] border border-dashed border-border bg-sunken text-center",
          "motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-[var(--ease-out)]",
          dragging && "border-accent bg-accent-soft",
          disabled && "opacity-60",
          variant === "card" ? "px-3 py-4" : "px-6 py-8",
        )}
      >
        <Upload
          aria-hidden="true"
          className={cn("text-text-muted", variant === "card" ? "size-4" : "size-5")}
        />

        <p
          className={cn(
            "leading-relaxed text-text-secondary",
            variant === "card" ? "text-xs" : "text-sm",
          )}
        >
          Drop a new HTML file to replace this page. The address stays the same.
        </p>

        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept="text/html,.html,.htm,.xhtml"
          disabled={disabled}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.item(0);
            // Cleared so choosing the SAME file twice fires `change` again —
            // a second attempt after a failure is the common case here.
            event.target.value = "";
            if (file) void send(file);
          }}
        />

        <Button
          type="button"
          variant={variant === "card" ? "ghost" : "secondary"}
          size="sm"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className={variant === "card" ? "px-2 text-xs" : undefined}
        >
          {busy ? (
            <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />
          ) : phase === "done" ? (
            <Check aria-hidden="true" />
          ) : null}
          {busy ? "Replacing…" : phase === "done" ? "Replaced" : "Choose file"}
          <span className="sr-only"> for {name}</span>
        </Button>
      </div>

      {refusal ? (
        <p className="text-xs leading-relaxed text-text-secondary">{refusal}</p>
      ) : expiresAt ? (
        // Only a draft has a clock to be wrong about.
        <p className="text-xs leading-relaxed text-text-muted">{REPLACE_CLOCK_NOTE}</p>
      ) : null}

      {/* One polite live region for both outcomes: the result of a replace is
          the whole point of the interaction and must not be visual-only. */}
      <p aria-live="polite" className="sr-only">
        {error ?? notice ?? ""}
      </p>

      {error ? (
        <p className="text-xs leading-relaxed text-danger">{error}</p>
      ) : notice ? (
        <p className="text-xs leading-relaxed text-text-secondary">{notice}</p>
      ) : null}
    </div>
  );
}
