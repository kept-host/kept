"use client";

/**
 * A moderation read that failed (§9: "inline with retry"). Rendered inside the
 * `/admin` shell. Retry re-runs the server component — `router.refresh()` then
 * `reset()` in one transition, as the studio's error screens do. Only the
 * digest is shown: the message is a server exception's text.
 */
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";

export default function ModerationError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const [retrying, startRetry] = useTransition();

  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-[var(--r-lg)] border border-border bg-surface p-5">
      <p className="text-[15px] text-text">Couldn&rsquo;t load this. Nothing was changed.</p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={retrying}
        onClick={() =>
          startRetry(() => {
            router.refresh();
            reset();
          })
        }
        className="font-body font-medium"
      >
        {retrying ? "Retrying…" : "Retry"}
      </Button>
      {error.digest ? (
        <span className="font-mono text-xs tracking-[0.08em] text-text-secondary">REFERENCE {error.digest}</span>
      ) : null}
    </div>
  );
}
