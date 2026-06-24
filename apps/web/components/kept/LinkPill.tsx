"use client";

import { ArrowUpRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * LinkPill — a sunken mono pill showing a *.kept.host slug (frontend-specs §4
 * bespoke list, design source). A sunken well (inset shadow) with the ↗ glyph
 * that raises a soft shadow on hover. Static presentational here; the publish
 * flow (E1) wires the real slug + copy/open actions. Renders as a button so the
 * keyboard path is intact, with `onClick` unbound until E1.
 */
export function LinkPill({
  slug,
  className,
}: {
  slug: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-2 rounded-[var(--r-md)] border border-border bg-sunken px-3.5 py-2 font-mono text-[13px] text-text-secondary",
        "shadow-[inset_0_1px_2px_color-mix(in_srgb,var(--text)_8%,transparent)]",
        "transition-all duration-150 ease-[var(--ease-out)] hover:text-text hover:shadow-[var(--shadow-md)]",
        className,
      )}
    >
      {slug}
      <ArrowUpRight className="size-3" />
    </button>
  );
}
