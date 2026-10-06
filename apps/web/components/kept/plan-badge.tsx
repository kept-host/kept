import type { Plan } from "@kept/shared";

import { cn } from "@/lib/utils";

/**
 * The account's plan, named — PRD §3 item 3 / §5.8. `Founding` arrives with
 * E11; until then `profiles.plan` is `free | premium`, shown as Free / Pro.
 * Better Auth has no opinion about plans, so the label mapping lives here, once.
 */
export const PLAN_LABEL: Record<Plan, string> = {
  free: "Free",
  premium: "Pro",
};

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
