"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

/**
 * Wraps next-themes so the kept token blocks (`[data-theme="dark"]`) swap
 * cleanly. Configured by the caller — see `app/providers.tsx`, which is the
 * only mount site:
 *   - attribute="data-theme"  → toggles our token block, not a `class`
 *   - forcedTheme="light"     → v1 ships light-only, deliberately (see below)
 *   - enableSystem={false}    → prefers-color-scheme is NOT consulted
 *
 * **v1 has no theme toggle and does not respect the OS.** E00 (`6117a26`)
 * removed the v1 toggle when the landing was rebuilt to Claude Design v2,
 * which has none in the design, and pinned the theme instead. `setTheme` is
 * called nowhere in this repo. This wrapper stays because the dark token block
 * is still exercised — the e2e specs set `data-theme` imperatively — and
 * because unforcing it is a landing redesign, not a config change.
 *
 * next-themes injects a pre-hydration script, so there is no flash of the
 * wrong theme and no hydration mismatch.
 */
export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
