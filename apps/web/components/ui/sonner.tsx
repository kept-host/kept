"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * kept toast surface — Sonner re-skinned with kept tokens via the theme API so
 * toasts read as kept, not stock Sonner. Follows the active data-theme.
 */
function Toaster({ ...props }: ToasterProps) {
  const { resolvedTheme } = useTheme();

  return (
    <Sonner
      theme={(resolvedTheme as ToasterProps["theme"]) ?? "light"}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--surface)",
          "--normal-text": "var(--text)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--r-md)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast:
            "group toast bg-surface text-text border border-border shadow-[var(--shadow-md)] rounded-[var(--r-md)] font-body",
          description: "text-text-secondary",
          actionButton: "bg-accent text-white",
          cancelButton: "bg-sunken text-text-secondary",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
