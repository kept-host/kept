"use client";

import * as React from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * kept ThemeToggle (frontend-specs §4 bespoke list).
 *
 * Backed by next-themes: light is the default, the first visit follows
 * `prefers-color-scheme` (System), and the chosen value persists. next-themes
 * injects a blocking pre-hydration script, so there is no flash of the wrong
 * theme and no hydration mismatch. We render a stable placeholder until mounted
 * to keep the SSR/CSR markup identical.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="icon"
          aria-label="Toggle theme"
          suppressHydrationWarning
        >
          {mounted ? (
            <>
              <Sun className="hidden dark:block" />
              <Moon className="block dark:hidden" />
            </>
          ) : (
            <Sun />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => setTheme("light")}
          data-active={mounted && theme === "light"}
          className="data-[active=true]:text-accent"
        >
          <Sun />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setTheme("dark")}
          data-active={mounted && theme === "dark"}
          className="data-[active=true]:text-accent"
        >
          <Moon />
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setTheme("system")}
          data-active={mounted && theme === "system"}
          className="data-[active=true]:text-accent"
        >
          <Monitor />
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
