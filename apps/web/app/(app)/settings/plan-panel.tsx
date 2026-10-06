/**
 * Plan — the badge, the usage meters and, on Free, what Pro adds. PRD §5.8;
 * E06 task 012 built it, task 013 restyled it to `kept Settings
 * Screen.dc.html` (section `plan`).
 *
 * The design's "Usage" card becomes two meters, `Kept {k} / {limit}` and
 * `Names {c} / {quota}`, under the plan badge. Its plan cards (Free / Founding
 * / Pro with prices and "Apply as a founding creator") are not rendered: prices
 * and Founding are E11's. What stays is the short Pro list as `LockedRow`s
 * (D15) — `PRO_LIST`, the same list the page detail screen reads — and only on
 * Free. A Pro account sees its own limits in the meters and nothing locked.
 *
 * ⚠️ NO TYPED LIMIT. `kept` is `keptQuotaFor`'s answer (the cap's own count and
 * `limitsFor(plan).keptPages`) and the name quota is `limitsFor(plan)` (D1), so
 * the copy moves the day a limit does.
 */
import { limitsFor, type Plan } from "@kept/shared";

import { LockedRow } from "@/components/kept/locked-row";
import { PlanBadge } from "@/components/kept/plan-badge";
import { PRO_LIST } from "@/lib/plans/pro-list";
import { cn } from "@/lib/utils";

import { SettingsCard } from "./settings-card";

export function PlanPanel({
  plan,
  kept,
  names,
}: {
  plan: Plan;
  /** `keptQuotaFor(profile.id)`'s `used` and `limit`. */
  kept: { used: number; limit: number };
  /** `chosenNameCount(profile.id)`. */
  names: number;
}) {
  return (
    <>
      <SettingsCard title="Plan" aside={<PlanBadge plan={plan} />}>
        <Meter id="kept" label="Kept" used={kept.used} limit={kept.limit} />
        <Meter id="names" label="Names" used={names} limit={limitsFor(plan).chosenNames} />
        <p className="text-[13px] text-text-secondary">
          Drafts are unlimited. Past {kept.limit}, new pages land as drafts.
        </p>
      </SettingsCard>

      {plan === "free" ? (
        <SettingsCard title="Pro" data-testid="pro-list">
          <ul className="-my-3 divide-y divide-border">
            {PRO_LIST.map((line) => (
              <li key={line}>
                <LockedRow>{line}</LockedRow>
              </li>
            ))}
          </ul>
        </SettingsCard>
      ) : null}
    </>
  );
}

/**
 * One usage meter: the mono count line and the design's 6px bar. A full meter
 * turns `--warning`, the same rule the Pages counters use at the kept limit.
 */
function Meter({
  id,
  label,
  used,
  limit,
}: {
  id: string;
  label: string;
  used: number;
  limit: number;
}) {
  const full = used >= limit;
  const share = limit > 0 ? Math.min(100, (used / limit) * 100) : 100;

  return (
    <div data-testid={`meter-${id}`} className="flex flex-col gap-2">
      <div
        className={cn(
          "flex items-baseline justify-between gap-3 font-mono text-xs font-medium uppercase tracking-[0.08em]",
          full ? "text-warning" : "text-text",
        )}
      >
        <span className={full ? undefined : "text-text-secondary"}>{label}</span>
        <span>
          {used} / {limit}
        </span>
      </div>
      <div aria-hidden="true" className="flex h-1.5 rounded-[3px] bg-sunken">
        <span
          className={cn("rounded-[3px]", full ? "bg-warning" : "bg-accent")}
          style={{ width: `${share}%` }}
        />
      </div>
    </div>
  );
}
