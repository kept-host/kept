"use client";

/**
 * One copyable value on `/referrals` — the design's code and link rows: a
 * mono value and a Copy button that says "Copied" for a moment.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { COPY_FAILED } from "@/lib/sites/display";

const COPIED_MS = 1600;

export function CopyField({ label, value, testId }: { label?: string; value: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      toast.error(COPY_FAILED);
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }

  return (
    <div className="flex h-11 min-w-0 items-center gap-2 rounded-[var(--r-sm)] border border-border pl-3 pr-1">
      {label ? <span className="font-mono text-xs text-text-secondary">{label}</span> : null}
      <span data-testid={testId} className="min-w-0 flex-1 truncate font-mono text-sm text-text">
        {value}
      </span>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`Copy ${label ? label.toLowerCase() : "link"}`}
        className="h-9 shrink-0 rounded-[6px] bg-sunken px-2.5 font-mono text-[11px] tracking-[0.04em] text-text outline-none hover:bg-border focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span aria-live="polite">{copied ? "COPIED" : "COPY"}</span>
      </button>
    </div>
  );
}
