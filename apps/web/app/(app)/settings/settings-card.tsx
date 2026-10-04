import { cn } from "@/lib/utils";

/**
 * One settings card — `kept Settings Screen.dc.html`'s section box: a 16px
 * surface card with a hairline border, a display-face heading and an optional
 * aside on the heading row. Every section on `/settings` is built from it, so
 * the five cards cannot drift into five versions of one box. E06 task 013.
 *
 * `danger` is the design's Delete-account border: the danger token mixed into
 * the hairline, never a pasted hex.
 *
 * Server-safe and stateless, so a server component and a client island render
 * the same markup.
 */
export function SettingsCard({
  title,
  aside,
  danger = false,
  className,
  children,
  ...props
}: React.ComponentProps<"section"> & {
  title: string;
  /** Rendered at the end of the heading row — the plan badge, for one. */
  aside?: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <section
      {...props}
      className={cn(
        "flex flex-col gap-4 rounded-[var(--r-lg)] border bg-surface p-5",
        danger ? "border-[color-mix(in_srgb,var(--danger)_30%,var(--border))]" : "border-border",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-xl font-semibold tracking-[-0.02em] text-text">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
