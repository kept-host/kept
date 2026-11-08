"use client";

/**
 * `/referrals` when its read failed. Says what did NOT happen: the link keeps
 * working and sign-ups keep counting — only this view failed. Retry re-runs the
 * server component (`router.refresh()` then `reset()`, as the Pages home does).
 * `error.digest` is the only detail shown.
 */
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function ReferralsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const [retrying, startRetry] = useTransition();

  return (
    <div className="flex max-w-[760px] flex-col gap-6 px-4 pb-24 pt-8 md:px-10">
      <h1 className="font-display text-[40px] font-bold leading-[1.1] tracking-[-0.03em] text-text">Referrals</h1>
      <div role="alert" className="flex flex-col items-start gap-3 rounded-[var(--r-lg)] border border-border bg-surface p-5">
        <h2 className="font-display text-xl font-semibold tracking-[-0.02em] text-text">We couldn&rsquo;t load your referrals.</h2>
        <p className="text-[15px] text-text-secondary">
          Your link still works and sign-ups still count — only this view failed. Try again.
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
          className="h-10 font-body font-medium"
        >
          <RotateCw aria-hidden="true" strokeWidth={1.5} />
          {retrying ? "Retrying…" : "Retry"}
        </Button>
        {error.digest ? (
          <span className="font-mono text-xs tracking-[0.08em] text-text-secondary">REFERENCE {error.digest}</span>
        ) : null}
      </div>
    </div>
  );
}
