"use client";

/**
 * The page that is arriving — the card's shape, in the landing's mint state
 * (E06 tasks 011, 015).
 *
 * The landing's drop tile (`kept-engine.ts`, `KeptLanding.tsx`) is hardwired to
 * its own engine and literals, so its language is rebuilt here from tokens, not
 * imported: the soft accent wash, a scan gradient sweeping down about once a
 * second, the spinner and "Keeping it…" over the file's name — and the mascot,
 * whose eyes ride the sweep. When the answer lands the mascot hops ("It's yours
 * now.") and the real card takes its place; when it fails the card says why,
 * in the server's words, with Try again and dismiss.
 *
 * Every movement is `motion-safe:`. Under reduced motion the mascot rests (it
 * starts no loop), there is no sweep and no hop, and the spinner is a still
 * glyph — every state still shows.
 */
import { useEffect, useRef } from "react";
import { Check, RotateCw, X } from "lucide-react";

import { MASCOT_DIM, Mascot, type MascotGaze } from "@/components/kept/mascot";
import { Button } from "@/components/ui/button";
import { prefersReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

import { ARRIVAL_SCROLL_MARGIN } from "./home-card";
import type { View } from "./toolbar";
import { MINT_HOP_MS, type Minting } from "./use-publish";

/** One sweep of the scan, top to bottom — the landing's, about once a second. */
const SCAN_PERIOD_S = 1.05;

/** The eyes ride the scan down, and flick back up as it starts over. Module scope: `gaze` must be stable. */
const followScan: MascotGaze = (seconds) => [0, ((seconds / SCAN_PERIOD_S) % 1) * 2 - 1];

const STAGE: Record<View | "draft", string> = {
  grid: "aspect-[16/10] rounded-t-[calc(var(--r-lg)-1px)] border-b",
  draft: "h-[88px] rounded-t-[calc(var(--r-lg)-1px)] border-b",
  list: "aspect-[16/10] w-24 shrink-0 rounded-[var(--r-sm)] border",
};

const MASCOT_SIZE: Record<View | "draft", string> = {
  grid: "size-14",
  draft: "size-11",
  list: "size-9",
};

export function MintCard({
  minting,
  variant,
  onRetry,
  onDismiss,
}: {
  minting: Minting;
  variant: View | "draft";
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const failed = minting.phase === "failed";
  const list = variant === "list";
  const itemRef = useRef<HTMLLIElement | null>(null);

  // Wherever the file was dropped, the card it is becoming is brought into view.
  useEffect(() => {
    itemRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, []);

  return (
    <li
      ref={itemRef}
      data-testid="mint-card"
      data-phase={minting.phase}
      aria-busy={minting.phase === "sending"}
      className={cn(
        "relative min-w-0 list-none rounded-[var(--r-lg)] border bg-surface",
        ARRIVAL_SCROLL_MARGIN,
        failed
          ? "border-[color-mix(in_srgb,var(--danger)_35%,var(--border))] shadow-[var(--shadow-sm)]"
          : "border-accent shadow-[0_0_40px_6px_color-mix(in_srgb,var(--accent)_28%,transparent)] ring-2 ring-accent",
        list && "flex items-center gap-3 p-2 pr-3",
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          "relative flex items-center justify-center overflow-hidden border-border",
          failed ? "bg-sunken" : "bg-[radial-gradient(120%_120%_at_50%_40%,var(--surface),var(--accent-soft))]",
          STAGE[variant],
        )}
      >
        {minting.phase === "sending" ? (
          <span
            className="absolute inset-x-0 hidden h-10 bg-[linear-gradient(to_bottom,color-mix(in_srgb,var(--accent)_45%,transparent),transparent)] motion-safe:block motion-safe:animate-[keptScan_1s_linear_infinite]"
            style={{ animationDuration: `${SCAN_PERIOD_S}s` }}
          />
        ) : null}
        <span
          data-testid="mint-mascot"
          className={cn(
            "relative",
            failed && MASCOT_DIM,
            minting.phase === "landed" && "motion-safe:animate-[keptHop_1s_var(--ease-out)_both]",
          )}
          style={{ animationDuration: `${MINT_HOP_MS}ms` }}
        >
          <Mascot className={cn("block text-accent", MASCOT_SIZE[variant])} gaze={failed ? undefined : followScan} />
        </span>
      </div>

      <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5", !list && "px-3.5 py-3")}>
        {failed ? (
          <p role="alert" className="text-sm leading-snug text-danger">
            {minting.error}
          </p>
        ) : (
          <p aria-live="polite" className="flex items-center gap-2 text-[15px] font-medium text-text">
            {minting.phase === "landed" ? (
              <Check aria-hidden="true" className="size-4 shrink-0 text-live" strokeWidth={2} />
            ) : (
              <span
                aria-hidden="true"
                className="size-4 shrink-0 rounded-full border-2 border-accent-soft border-t-accent motion-safe:animate-spin"
              />
            )}
            {minting.phase === "landed" ? "It's yours now." : "Keeping it…"}
          </p>
        )}
        <span className="truncate font-mono text-xs text-text-secondary">{minting.label}</span>

        {failed && !list ? <FailedActions onRetry={onRetry} onDismiss={onDismiss} className="mt-2" /> : null}
      </div>

      {failed && list ? <FailedActions onRetry={onRetry} onDismiss={onDismiss} className="shrink-0" /> : null}
    </li>
  );
}

function FailedActions({
  onRetry,
  onDismiss,
  className,
}: {
  onRetry: () => void;
  onDismiss: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <Button type="button" variant="secondary" size="sm" onClick={onRetry} className="font-body font-medium">
        <RotateCw aria-hidden="true" strokeWidth={1.5} />
        Try again
      </Button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="flex size-9 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-text-secondary outline-none hover:bg-sunken hover:text-text focus-visible:ring-2 focus-visible:ring-accent"
      >
        <X aria-hidden="true" className="size-4" strokeWidth={1.5} />
      </button>
    </div>
  );
}
