"use client";

/**
 * The dashboard when its read failed — E06 task 003.
 *
 * A RECOVERABLE STATE, NOT A CRASH. Next's default boundary is a blank page in
 * production; this one names what happened, says what it did *not* do, and hands
 * back a working control. `reset()` re-runs the server component — a real retry
 * against Postgres, not a page reload that discards the router.
 *
 * IT DOES NOT APOLOGISE AND IT DOES NOT SPECULATE (§10). The one thing the owner
 * of a hosting product needs to hear first is that their pages are still being
 * served, because the serve path is 100% Cloudflare and a control-plane outage
 * cannot take a hosted page offline. That is the architecture's promise, so this
 * screen is entitled to make it.
 *
 * `error.digest` is deliberately the only detail shown: the message is a server
 * exception's text and may name a table, a column or a connection string.
 */
import { RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex w-full max-w-[34rem] flex-col items-start gap-5 px-6 py-20 md:px-8">
      <p className="mono-label text-[11px] text-danger">Could not load</p>

      <h1 className="font-display text-[clamp(1.8rem,4.6vw,2.5rem)] font-bold text-text">
        Your pages did not load
      </h1>

      <p className="leading-relaxed text-text-secondary">
        Something went wrong reading your account. Nothing was changed, and every
        page you have published is still being served at its own link — this
        screen is the only thing that is down.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={reset}>
          <RotateCw aria-hidden="true" />
          Try again
        </Button>
      </div>

      {error.digest ? (
        <p className="mono-label text-[10px] text-text-muted">
          Reference {error.digest}
        </p>
      ) : null}
    </main>
  );
}
