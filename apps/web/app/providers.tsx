"use client";

import type { ReactNode } from "react";

import { ThemeProvider } from "@/components/kept/ThemeProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

/**
 * Client providers mounted once at the root.
 *
 * Theme is driven by `data-theme` and is **pinned to light**. There is no
 * toggle, `prefers-color-scheme` is not consulted, and nothing persists — v1
 * ships light-only on purpose. `layout.tsx` sets `data-theme="light"` on
 * `<html>` for the same reason, so the server markup already matches.
 *
 * Do not remove `forcedTheme` to "enable dark mode": `KeptLanding.tsx` builds
 * its light→dark→light band rhythm out of inline colour literals, so an
 * unforced theme breaks the landing. See CLAUDE.md, "Locked decisions".
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="data-theme"
      defaultTheme="light"
      forcedTheme="light"
      enableSystem={false}
      disableTransitionOnChange
    >
      <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
      <Toaster />
    </ThemeProvider>
  );
}
