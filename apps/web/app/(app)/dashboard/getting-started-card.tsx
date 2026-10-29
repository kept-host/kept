"use client";

/**
 * The getting-started card on the Pages home (E10 §5.3, task 010). Three steps,
 * each ticked from live data the server already read: keep a page, claim a
 * handle, and share the referral link (ticked once one sign-up has come
 * through it — a share itself cannot be seen).
 *
 * The skin is the "Claim your handle" card of `kept Studio Screen.dc.html`
 * (eyebrow, heading, one line, white card); the step rows have no design (Q10)
 * and are built from tokens.
 *
 * Hidden once every step is done. Dismissal is per viewer and per browser:
 * `localStorage`, read after mount and wrapped in try/catch, so the card always
 * renders without it (a private window simply shows it again).
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";

import { cn } from "@/lib/utils";

const DISMISSED_KEY = "kept.getting-started.dismissed";

export interface GettingStartedSteps {
  kept: boolean;
  handle: boolean;
  referral: boolean;
}

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    window.localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Storage unavailable: the dismissal lasts until the next page load.
  }
}

export function GettingStartedCard({ steps }: { steps: GettingStartedSteps }) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (readDismissed()) setDismissed(true);
  }, []);

  const rows = [
    { id: "kept", done: steps.kept, label: "Keep a page", note: "Keep a draft and it stays at its link for good.", href: "/dashboard?tab=drafts" },
    { id: "handle", done: steps.handle, label: "Claim your handle", note: "One name on every page you keep.", href: "/settings?section=profile" },
    { id: "referral", done: steps.referral, label: "Share your referral link", note: "See who signed up through it.", href: "/referrals" },
  ] as const;

  if (dismissed || rows.every((row) => row.done)) return null;

  return (
    <section
      aria-labelledby="getting-started-heading"
      data-testid="getting-started"
      className="flex max-w-[640px] flex-col gap-3 rounded-[var(--r-lg)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]"
    >
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="font-mono text-xs font-medium uppercase tracking-[0.08em] text-text-secondary">
            Getting started
          </span>
          <h2
            id="getting-started-heading"
            className="font-display text-xl font-semibold leading-[1.2] tracking-[-0.02em] text-text"
          >
            Make kept yours
          </h2>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            writeDismissed();
            setDismissed(true);
          }}
          className="flex size-8 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-text-secondary outline-none hover:bg-sunken hover:text-text focus-visible:ring-2 focus-visible:ring-accent"
        >
          <X aria-hidden="true" className="size-4" strokeWidth={1.5} />
        </button>
      </div>
      <ol className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.id} data-testid={`getting-started-${row.id}`} data-done={row.done}>
            <Link
              href={row.href}
              className="flex items-start gap-3 rounded-[var(--r-sm)] px-2 py-2 outline-none hover:bg-sunken focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border",
                  row.done ? "border-accent bg-accent text-white" : "border-border bg-surface",
                )}
              >
                {row.done ? <Check className="size-3.5" strokeWidth={2} /> : null}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className={cn("text-[15px] font-medium", row.done ? "text-text-secondary line-through" : "text-text")}>
                  {row.label}
                  <span className="sr-only">{row.done ? " (done)" : " (to do)"}</span>
                </span>
                <span className="text-sm text-text-secondary">{row.note}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
