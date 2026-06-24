"use client";

import type { ReactNode } from "react";

import { ThemeProvider } from "@/components/kept/ThemeProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

/**
 * Client providers mounted once at the root. Theme is driven by data-theme
 * (light default, system on first visit, then persisted — no FOUC).
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="data-theme"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
      <Toaster />
    </ThemeProvider>
  );
}
