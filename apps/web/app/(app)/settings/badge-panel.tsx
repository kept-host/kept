"use client";

/**
 * Settings → Badge (E10 D3, PRD §4.7, §10.3): which badge the account's kept
 * pages wear. NO IMPORTED DESIGN (Q10) — built from tokens and flagged for
 * Arun's review.
 *
 * `standard` is everyone's. `minimal` is Pro (`mayUseMinimalBadge`, Q19): a
 * Pro account picks it like `standard`; a free one sees the locked row and no
 * CTA beyond the existing Pro list (`LockedRow`). A pick saves at once —
 * `PATCH /api/profile { badgeStyle }` — and the server re-syncs every kept page
 * through the repurge job, so the page says when it will show.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { BadgeStyle } from "@kept/shared";

import { LockedRow } from "@/components/kept/locked-row";
import { saveProfile } from "@/lib/sites/owner-client";
import { cn } from "@/lib/utils";

import { SettingsCard } from "./settings-card";

const STYLES: readonly { style: BadgeStyle; label: string; line: string }[] = [
  {
    style: "standard",
    label: "Standard",
    line: "The kept mark and every link it carries — always open.",
  },
  {
    style: "minimal",
    label: "Minimal",
    line: "A small kept mark that opens to the same contents.",
  },
];

const BADGE_SAVED_TOAST = "Saved. Showing on your pages in about 2 minutes.";

export function BadgePanel({ badgeStyle, mayUseMinimal }: { badgeStyle: BadgeStyle; mayUseMinimal: boolean }) {
  const [current, setCurrent] = useState(badgeStyle);
  const [saving, setSaving] = useState<BadgeStyle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);

  async function pick(style: BadgeStyle) {
    if (style === current || saving) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setSaving(style);
    setError(null);
    const outcome = await saveProfile({ badgeStyle: style }, controller.signal);
    if (controller.signal.aborted) return;
    setSaving(null);
    if (!outcome.ok) {
      setError(outcome.error.message);
      return;
    }
    setCurrent(outcome.result.badgeStyle);
    toast.success(BADGE_SAVED_TOAST);
  }

  const offered = mayUseMinimal ? STYLES : STYLES.filter((option) => option.style === "standard");

  return (
    <SettingsCard title="Badge" data-testid="badge-section">
      <p className="text-[15px] text-text-secondary">
        Every kept page carries a small badge: credit, your referral link and a report link. Drafts always show
        the draft badge.
      </p>

      <div role="radiogroup" aria-label="Badge style" className="flex flex-col gap-2">
        {offered.map((option) => {
          const on = option.style === current;
          return (
            <button
              key={option.style}
              type="button"
              role="radio"
              aria-checked={on}
              data-testid={`badge-style-${option.style}`}
              disabled={saving !== null}
              onClick={() => void pick(option.style)}
              className={cn(
                "flex items-start gap-3 rounded-[var(--r-md)] border px-3.5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent",
                on ? "border-accent bg-accent-soft" : "border-border bg-surface hover:bg-sunken",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "mt-1 size-3.5 shrink-0 rounded-full border",
                  on ? "border-accent bg-accent" : "border-text-muted bg-surface",
                )}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[15px] font-medium text-text">
                  {option.label}
                  {saving === option.style ? <span className="text-text-secondary"> · Saving…</span> : null}
                </span>
                <span className="text-sm leading-relaxed text-text-secondary">{option.line}</span>
              </span>
            </button>
          );
        })}
      </div>

      {mayUseMinimal ? null : (
        <div data-testid="badge-minimal-locked" className="border-t border-border">
          <LockedRow>A minimal badge — a small kept mark that opens on tap — with Pro</LockedRow>
        </div>
      )}

      <div role="alert" data-testid="badge-error" className={cn("text-[13px] text-danger", !error && "sr-only")}>
        {error}
      </div>
    </SettingsCard>
  );
}
