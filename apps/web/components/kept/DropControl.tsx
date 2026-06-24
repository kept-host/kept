"use client";

import { cn } from "@/lib/utils";

/**
 * DropControl — the hero's `↑ Drop a file or browse` control (design-system §12,
 * frontend-specs §4 mono text-link). A JetBrains-Mono control with a 1.5px solid
 * underline that lifts and turns accent on hover, distinct from the generic link
 * button (this one is `--text`, sentence case, solid border-bottom — not an
 * accent text-underline).
 *
 * Static here: the publish/drag wiring is E1. It renders as a real button so the
 * keyboard path is intact (visible accent focus ring via globals), but `onClick`
 * is intentionally unbound until E1.
 */
export function DropControl({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={cn(
        "group inline-flex items-center gap-2.5 border-b-[1.5px] border-text bg-transparent px-0.5 pb-[5px] font-mono text-sm text-text",
        "transition-all duration-200 ease-[var(--ease-out)] hover:-translate-y-0.5 hover:border-accent hover:text-accent",
        className,
      )}
    >
      <span className="text-base">&uarr;</span> Drop a file or browse
    </button>
  );
}
