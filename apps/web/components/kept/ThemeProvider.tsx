"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

/**
 * Wraps next-themes so the kept token blocks (`[data-theme="dark"]`) swap
 * cleanly. Configured at the layout level:
 *   - attribute="data-theme"  → toggles our token block, not a `class`
 *   - defaultTheme="system"   → first visit respects prefers-color-scheme
 *   - enableSystem            → tracks the OS until the user picks
 * next-themes injects a pre-hydration script, so there is no flash of the
 * wrong theme and no hydration mismatch.
 */
export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
