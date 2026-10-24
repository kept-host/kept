import type { Plan } from "@kept/shared";

import { PLAN_LABEL } from "@/lib/plans/plan-label";
import { cn } from "@/lib/utils";

/** The studio's plan pill (`kept Studio Screen.dc.html`, the sidebar's plan card). */
export function PlanBadge({ plan, className }: { plan: Plan; className?: string }) {
  return (
    <span
      data-testid="plan-badge"
      className={cn(
        "inline-flex h-[22px] items-center rounded-[var(--r-pill)] border border-border bg-sunken px-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-text",
        className,
      )}
    >
      {PLAN_LABEL[plan]}
    </span>
  );
}
