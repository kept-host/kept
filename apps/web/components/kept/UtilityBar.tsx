import { ThemeToggle } from "@/components/kept/ThemeToggle";

const NAV_LINKS = [
  { label: "About", href: "#why" },
  { label: "Open Source", href: "#why" },
  { label: "For Agents", href: "#agents" },
  { label: "Support", href: "#support" },
] as const;

/**
 * UtilityBar — sticky landing nav (frontend-specs §4 bespoke list).
 *
 * kept wordmark · in-page nav · ThemeToggle (re-skinned shadcn, from task 003)
 * · the live "pages kept" counter. The counter shows placeholder data only;
 * E4 wires it to Supabase Realtime.
 */
export function UtilityBar() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-[color-mix(in_srgb,var(--bg)_86%,transparent)] backdrop-blur-md backdrop-saturate-150">
      <div className="mx-auto flex h-18 max-w-[1280px] items-center justify-between px-6 md:px-12">
        <a
          href="#top"
          className="font-display text-2xl font-bold tracking-[-0.03em] text-text"
        >
          kept
        </a>
        <div className="flex items-center gap-5 md:gap-7">
          <nav className="hidden items-center gap-6 md:flex">
            {NAV_LINKS.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="mono-label text-xs text-text-secondary transition-colors hover:text-text"
              >
                {link.label}
              </a>
            ))}
          </nav>
          <ThemeToggle />
          <div className="hidden h-[22px] w-px bg-border sm:block" />
          <div className="hidden items-center gap-2 sm:flex">
            <span className="font-mono text-xs tracking-[0.08em] text-text">
              1,284
            </span>
            <span className="mono-label text-xs text-text-muted">
              Pages Kept
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}
