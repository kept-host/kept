"use client";

import * as React from "react";
import { useTheme } from "next-themes";

/**
 * kept ThemeToggle — bespoke pill switch (design-system §9, frontend-specs §4).
 *
 * A ~60×30 pill with inline sun/moon glyphs and a spring-eased sliding knob,
 * driving next-themes (light default; first visit follows `prefers-color-scheme`
 * via the provider, then persists). next-themes injects a blocking pre-hydration
 * script, so to avoid a hydration mismatch we render the knob in its light
 * position until mounted, then animate it to the resolved theme.
 *
 * Tokens are law: every colour is a CSS var, the knob transition uses
 * `--ease-spring`, and focus shows the global accent ring.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = mounted && resolvedTheme === "dark";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label="Toggle dark mode"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="relative flex h-[30px] w-[60px] items-center justify-between rounded-[var(--r-pill)] border border-border bg-sunken px-[7px]"
    >
      {/* sun */}
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--text-muted)"
        strokeWidth="2"
        aria-hidden
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
      </svg>
      {/* moon */}
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--text-muted)"
        strokeWidth="2"
        aria-hidden
      >
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
      {/* sliding knob */}
      <span
        aria-hidden
        suppressHydrationWarning
        className="absolute left-[3px] top-[3px] size-6 rounded-[var(--r-pill)] bg-surface shadow-[var(--shadow-sm)] transition-transform duration-300 [transition-timing-function:var(--ease-spring)]"
        style={{ transform: isDark ? "translateX(30px)" : "translateX(0)" }}
      />
    </button>
  );
}
