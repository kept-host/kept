import { ArrowUpRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * LinkPill — a sunken mono pill showing a *.kept.host slug (frontend-specs §4
 * bespoke list). Static presentational only here; the publish flow (E1) wires
 * the real slug + copy/open actions. Renders as a styled non-interactive chip.
 */
export function LinkPill({
  slug,
  className,
}: {
  slug: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-[var(--r-md)] border border-border bg-sunken px-3.5 py-2 font-mono text-[13px] text-text-secondary",
        className,
      )}
    >
      {slug}
      <ArrowUpRight className="size-3" />
    </span>
  );
}
