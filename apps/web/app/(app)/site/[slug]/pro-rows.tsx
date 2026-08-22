/**
 * The five things Pro will unlock — E06 task 008.
 *
 * ⚠️ FINISHED MARKUP, NOT SCAFFOLDING, AND THE DIFFERENCE IS THE WHOLE POINT.
 * There is no feature flag here, no entitlement check, no `plan === "premium"`
 * branch and no dead code path waiting to be switched on. E11 **replaces** this
 * component with the real controls; it does not un-stub a half-built system, and
 * a half-built one would be five places for an entitlement bug to hide in the
 * meantime.
 *
 * ⚠️ THE UPGRADE CONTROL REFUSES RATHER THAN LIES. There is no checkout, no
 * pricing page and no merchant of record yet — E11 owns all three — so the
 * button is inert and the caption says why. A live-looking button that silently
 * did nothing would be the one interaction on this screen that behaves like a
 * bug, on the one row where the product is asking for money.
 *
 * The lock is `aria-hidden` and every row states its own status in words:
 * decoration carries no information, and "Pro" is the information.
 */
import { Lock } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Name and one honest line each. No feature is described as nearly-ready. */
const PRO_FEATURES: ReadonlyArray<{ name: string; blurb: string }> = [
  {
    name: "Password protection",
    blurb: "Put a password in front of a page without making it unlisted.",
  },
  {
    name: "Custom domain",
    blurb: "Serve this page from a domain you own instead of a kept subdomain.",
  },
  {
    name: "Analytics",
    blurb: "Page views and referrers, counted at the edge and never sold on.",
  },
  {
    name: "Remove the badge",
    blurb: "Serve the page without the small kept mark in the corner.",
  },
  {
    name: "Version rollback",
    blurb: "Every replace keeps the previous file. Go back to any of them.",
  },
];

export function ProRows() {
  return (
    <section className="rounded-[var(--r-lg)] border border-border bg-sunken p-5 shadow-[var(--shadow-sm)]">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-base font-semibold text-text">Pro</h2>
        <p className="mono-label text-[10px] text-text-muted">Not yet available</p>
      </div>

      <ul className="mt-4 divide-y divide-border border-y border-border">
        {PRO_FEATURES.map((feature) => (
          <li key={feature.name} className="flex items-start gap-3 py-3">
            <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-text-muted" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-text">
                {feature.name}
                <span className="sr-only"> — a Pro feature, locked</span>
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-text-muted">
                {feature.blurb}
              </p>
            </div>
          </li>
        ))}
      </ul>

      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled
        className="mt-4 w-full"
      >
        Upgrade
      </Button>
      <p className="mt-2 text-xs leading-relaxed text-text-muted">
        Pro is not on sale yet. Subscriptions are what fund the free tier, and the
        books will be public when they are.
      </p>
    </section>
  );
}
