"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * kept toast surface — Sonner re-skinned with kept tokens via the theme API so
 * toasts read as kept, not stock Sonner. Follows the active data-theme.
 *
 * The studio design's toast (E06 task 011): inverted — `--text` ground,
 * `--bg` ink — bottom centre, a `--live` check on success and the page's
 * address underneath in mono. Inverting through the two tokens keeps it
 * correct in both themes without a colour of its own.
 */
function Toaster({ ...props }: ToasterProps) {
  const { resolvedTheme } = useTheme();

  return (
    <Sonner
      theme={(resolvedTheme as ToasterProps["theme"]) ?? "light"}
      position="bottom-center"
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--text)",
          "--normal-text": "var(--bg)",
          "--normal-border": "var(--text)",
          "--border-radius": "var(--r-md)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast:
            "group toast bg-text text-bg border border-text shadow-[var(--shadow-lg)] rounded-[var(--r-md)] font-body text-sm font-medium",
          description: "font-mono text-xs font-normal text-text-muted",
          success: "[&_[data-icon]]:text-live",
          error: "[&_[data-icon]]:text-danger",
          actionButton:
            "!bg-transparent !text-bg border border-[color-mix(in_srgb,var(--bg)_25%,transparent)] font-mono text-xs uppercase tracking-[0.08em]",
          cancelButton: "!bg-transparent !text-text-muted",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
