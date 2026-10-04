import Link from "next/link";

import { cn } from "@/lib/utils";

/**
 * The studio wordmark, home to Pages — the sidebar's on desktop and each
 * screen's top bar on a phone (`kept Studio Screen.dc.html`). Size is the
 * caller's; the face is the display token.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <Link
      href="/dashboard"
      className={cn(
        "rounded-[var(--r-sm)] font-display font-bold leading-none tracking-[-0.04em] text-text no-underline outline-none focus-visible:ring-2 focus-visible:ring-accent",
        className,
      )}
    >
      kept
    </Link>
  );
}
