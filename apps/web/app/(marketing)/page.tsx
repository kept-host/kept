import { FREE_PAGE_LIMIT, SLOT_COST_EUR } from "@kept/shared";

import { ThemeToggle } from "@/components/kept/ThemeToggle";
import { ComponentPreview } from "@/components/kept/ComponentPreview";

/**
 * (marketing) home — temporary preview surface for E-Foundation task 003.
 *
 * Purpose: prove the themed shell works end to end — kept tokens applied, all
 * three fonts loaded, re-skinned shadcn components rendering as kept (not
 * stock), a working light/dark ThemeToggle, and a live import from
 * packages/shared. The real landing page is adopted in task 007; this page is
 * replaced then.
 */
export default function MarketingHome() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col gap-12 px-6 py-16">
      <header className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-3">
          <p className="mono-label text-text-muted">E-Foundation · shell</p>
          <h1 className="font-display text-5xl font-bold tracking-tight text-text">
            kept is themed.
          </h1>
          <p className="max-w-prose text-lg text-text-secondary">
            Tokens are law: this whole surface is driven by the kept{" "}
            <code className="font-mono text-accent">@theme</code> variables. No
            hardcoded hex. shadcn provides behavior; the look is kept.
          </p>
          <p className="text-sm text-text-muted">
            From{" "}
            <span className="font-mono text-accent">@kept/shared</span>: free
            plan keeps {FREE_PAGE_LIMIT} pages · a slot costs €
            {SLOT_COST_EUR.toFixed(2)}.
          </p>
        </div>
        <ThemeToggle />
      </header>

      <ComponentPreview />
    </main>
  );
}
