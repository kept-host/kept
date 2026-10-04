/**
 * Plan — Free now, Pro later, and no machinery in between. E06 task 012.
 *
 * ⚠️ NO ENTITLEMENT PLUMBING, ON PURPOSE. `plan` is read from `profiles.plan`
 * and *displayed*; nothing on this screen or anywhere it links to branches on
 * it. `PLANS` is `free | premium` after E05's migration `0002`, and the day a
 * `premium` row exists this panel names it correctly without a single
 * `plan === "premium" ? …` gate having been written in advance. Five of those
 * gates written now would be five places for an entitlement bug to hide while
 * nothing is on sale.
 *
 * ⚠️ NO BILLING, NO PRICES, NO MERCHANT OF RECORD. E11 owns all three. A number
 * printed here would be a price the product cannot honour, and the MoR question
 * is explicitly open.
 *
 * The locked half is `components/kept/pro-rows.tsx` — the same component the
 * site-detail aside mounts, not a second list. This file owns only the "you are
 * on Free" half above it.
 */
import { Check } from "lucide-react";

import { limitsFor, type Plan } from "@kept/shared";

import { ProRows } from "@/components/kept/pro-rows";

/**
 * What the account's plan actually gives it, in the product's own vocabulary.
 *
 * ⚠️ NO TYPED LIMIT. `limitsFor(plan)` composes the sentence (D1), so the day
 * the cap moves — or this account changes plan — the copy moves with it instead
 * of turning the product into a liar. The draft clock is deliberately described
 * without a number here — the drafts section on the dashboard states
 * `DRAFT_TTL_DAYS` from the constant and two copies of the same promise drift.
 */
function planIncludes(plan: Plan): readonly string[] {
  return [
    `${limitsFor(plan).keptPages} pages kept forever, at links that never expire`,
    "Unlimited drafts, live the moment you drop a file",
    "Rename, replace and delete any page you own",
  ];
}

/** Better Auth has no opinion about plans; the label mapping lives here. */
const PLAN_LABEL: Record<Plan, string> = {
  free: "Free",
  premium: "Pro",
};

export function PlanPanel({ plan }: { plan: Plan }) {
  return (
    <section className="rounded-[var(--r-lg)] border border-border bg-surface p-6 shadow-[var(--shadow-sm)]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-4">
        <h2 className="font-display text-xl font-semibold text-text">Plan</h2>
        <p className="mono-label text-[11px] text-text-muted">
          Pro funds the free tier
        </p>
      </div>

      <div className="mt-5 rounded-[var(--r-md)] border border-accent bg-accent-soft px-4 py-3.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="font-display text-base font-semibold text-text">
            {PLAN_LABEL[plan]}
          </p>
          <p className="mono-label text-[10px] text-accent">Your plan</p>
        </div>
        <ul className="mt-3 flex flex-col gap-1.5">
          {planIncludes(plan).map((line) => (
            <li key={line} className="flex items-start gap-2.5">
              <Check
                aria-hidden="true"
                className="mt-0.5 size-3.5 shrink-0 text-accent"
              />
              <span className="text-sm leading-relaxed text-text-secondary">
                {line}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-5">
        <ProRows />
      </div>
    </section>
  );
}
