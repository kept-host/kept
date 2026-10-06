import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * One card of the page-detail screen — `kept Page Screen.dc.html`'s
 * `<section>`: surface, hairline, 16px radius, a display-face heading with an
 * optional status at its right (the design's "SAVING… / SAVED" slot).
 */
export function Section({
  title,
  status,
  tone = "default",
  className,
  children,
  testId,
}: {
  title: string;
  /** Right of the heading — the save state, a range toggle. */
  status?: ReactNode;
  /** `danger` is the Danger zone's tinted hairline. */
  tone?: "default" | "danger";
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className={cn(
        "flex flex-col gap-3 rounded-[var(--r-lg)] border bg-surface p-5",
        tone === "danger" ? "border-[color-mix(in_srgb,var(--danger)_30%,var(--border))]" : "border-border",
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <h2
          id={headingId}
          className="min-w-0 flex-1 font-display text-xl leading-[1.2] font-semibold tracking-[-0.02em] text-text"
        >
          {title}
        </h2>
        {status}
      </div>
      {children}
    </section>
  );
}
