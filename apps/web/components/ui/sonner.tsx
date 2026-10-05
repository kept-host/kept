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
 *
 * Secondary text on that ground is `--text-inverse-muted` (task 015), and it is
 * `!important` on purpose: Sonner's own stylesheet is unlayered, so its fixed
 * dark-grey `[data-description]` colour beat the layered utility and painted
 * the address near-black on near-black.
 *
 * Bottom offset: Sonner's own (24px, 16px on a phone) unless the studio's phone
 * tab bar is on screen, which sets `--toast-offset-bottom` (`globals.css`) so
 * the toast clears it — the design's 96px.
 */
function Toaster({ ...props }: ToasterProps) {
  const { resolvedTheme } = useTheme();

  return (
    <Sonner
      theme={(resolvedTheme as ToasterProps["theme"]) ?? "light"}
      position="bottom-center"
      className="toaster group"
      offset={{ bottom: "var(--toast-offset-bottom, 24px)" }}
      mobileOffset={{ bottom: "var(--toast-offset-bottom, 16px)" }}
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
          description: "font-mono text-xs font-normal !text-text-inverse-muted",
          success: "[&_[data-icon]]:text-live",
          error: "[&_[data-icon]]:text-danger",
          actionButton:
            "!bg-transparent !text-bg border border-[color-mix(in_srgb,var(--bg)_25%,transparent)] font-mono text-xs uppercase tracking-[0.08em]",
          cancelButton: "!bg-transparent !text-text-inverse-muted",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
