import Link from "next/link";
import { ChevronLeft } from "lucide-react";

/**
 * "‹ Pages" — the page-detail top bar's way back to the home
 * (`kept Page Screen.dc.html`). Shared by the screen, its archived view and its
 * not-found.
 */
export function BackLink() {
  return (
    <Link
      href="/dashboard"
      className="flex h-10 items-center gap-2 rounded-[var(--r-sm)] pr-3 pl-2 font-mono text-xs font-medium uppercase tracking-[0.08em] text-text-secondary outline-none hover:bg-sunken hover:text-text focus-visible:ring-2 focus-visible:ring-accent"
    >
      <ChevronLeft aria-hidden="true" className="size-[18px]" strokeWidth={1.5} />
      Pages
    </Link>
  );
}

/** The 64px top bar every state of the screen opens with; the wordmark on a phone. */
export const TOP_BAR =
  "sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-bg px-4 md:px-8";
