import { Lock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The locked pattern — D15, E06 task 010.
 *
 * One row saying what Pro adds: the value line always, a `PRO` pill, and a CTA
 * link **only when `NEXT_PUBLIC_LOCKED_CTA_URL` is set**. It is unset in E06 —
 * there is nothing to buy yet — and E11 sets it (to `/founding`, D-37). A link
 * rendered before its destination exists would be a dead button; hiding the row
 * instead would mean nobody learns what Pro adds. So the row stays and the link
 * waits. No price, ever: E11 owns pricing.
 *
 * Server-safe and stateless: `NEXT_PUBLIC_*` is inlined at build time, so the
 * same markup comes out of a server component and a client one.
 *
 * The look is the design's locked language (`kept Page Screen.dc.html`,
 * `kept Settings Screen.dc.html`): the `PRO` pill in `--accent-soft` /
 * `--accent-hover`, the lock `aria-hidden` and the status said in words.
 */
export function LockedRow({
  children,
  className,
}: {
  /** The value line — what Pro adds, e.g. "Keep 20 versions with Pro". */
  children: React.ReactNode;
  className?: string;
}) {
  const ctaUrl = process.env.NEXT_PUBLIC_LOCKED_CTA_URL;

  return (
    <div className={cn("flex items-center gap-3 py-3", className)}>
      <Lock aria-hidden="true" className="size-3.5 shrink-0 text-text-muted" />
      <p className="min-w-0 flex-1 text-sm leading-relaxed text-text">
        {children}
        <span className="sr-only"> — a Pro feature, locked</span>
      </p>
      <Badge aria-hidden="true" className="shrink-0 text-accent-hover">
        Pro
      </Badge>
      {ctaUrl ? (
        <a
          href={ctaUrl}
          className="shrink-0 rounded-[var(--r-sm)] text-[13px] text-text underline underline-offset-[3px] outline-none hover:text-accent-hover focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          See Pro
        </a>
      ) : null}
    </div>
  );
}
