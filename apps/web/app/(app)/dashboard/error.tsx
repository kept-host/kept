"use client";

/**
 * The Pages home when its read failed — PRD §9.1 full load error (`kept Studio
 * Screen.dc.html`, `view: error`, with the mascot `dim` in place of the icon).
 *
 * Says what happened and what did NOT: the serve path is 100% Cloudflare, so a
 * control-plane failure cannot take a hosted page offline, and this screen is
 * entitled to say so. Retry re-runs the server component — `router.refresh()`
 * then `reset()` in one transition, which is what re-fetches a server
 * component's data in Next 15 (a bare `reset()` would re-render the same
 * failed payload).
 *
 * `error.digest` is the only detail shown: the message is a server exception's
 * text and may name a table, a column or a connection string.
 */
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCw } from "lucide-react";

import { Mascot } from "@/components/kept/mascot";
import { Button } from "@/components/ui/button";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const [retrying, startRetry] = useTransition();

  return (
    <div className="flex flex-col gap-7 px-4 pb-24 pt-8 md:px-10 md:pt-24">
      <h1 className="font-display text-[40px] font-bold leading-[1.1] tracking-[-0.03em] text-text">
        Your pages
      </h1>
      <div
        role="alert"
        className="flex flex-col items-center gap-3 rounded-[var(--r-xl)] border border-border bg-surface px-6 py-14 text-center"
      >
        {/* The `dim` mood: the same frame, drained (02 §7). On a wrapper,
            because the mascot's own `filter` carries its drop shadow. */}
        <span className="[filter:grayscale(0.5)_opacity(0.5)]">
          <Mascot className="block size-20 text-accent" />
        </span>
        <h2 className="mt-1 font-display text-2xl font-semibold leading-tight tracking-[-0.03em] text-text">
          We couldn&rsquo;t load your pages.
        </h2>
        <p className="max-w-[46ch] text-[15px] text-pretty text-text-secondary">
          Your pages are still online — only this view failed. Check your connection and
          try again.
        </p>
        <Button
          type="button"
          variant="secondary"
          disabled={retrying}
          onClick={() =>
            startRetry(() => {
              router.refresh();
              reset();
            })
          }
          className="mt-2 h-10 font-body font-medium"
        >
          <RotateCw aria-hidden="true" strokeWidth={1.5} />
          {retrying ? "Retrying…" : "Retry"}
        </Button>
        {error.digest ? (
          <span className="font-mono text-xs tracking-[0.08em] text-text-secondary">
            REFERENCE {error.digest}
          </span>
        ) : null}
      </div>
    </div>
  );
}
