import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The studio's counters and its Publish button — E06 task 010 (PRD §5.1).
 *
 * `KEPT k / limit · NAMES c / quota`, then `DRAFTS d` only while there are
 * drafts, in the design's mono summary rule (`kept Studio Screen.dc.html`,
 * `view: normal / limit / mobile`). At the kept limit `KEPT` turns `--warning`,
 * value and bar alike.
 *
 * ⚠️ NO NUMBER LIVES HERE. Every count and every limit is a prop — the caller
 * passes `limitsFor(plan)`'s `keptPages` and `chosenNames` (D1) — so a Pro
 * account is never shown the free plan's ceiling. `counts: null` renders the
 * Publish button alone: the empty state has no counters (PRD §9.1), and that is
 * the caller's call, not this component's.
 */
export interface UtilityCounts {
  kept: number;
  keptLimit: number;
  names: number;
  nameQuota: number;
  drafts: number;
}

export function UtilityBar({
  counts,
  onPublish,
  className,
}: {
  counts: UtilityCounts | null;
  /** Opens the publish sheet. */
  onPublish: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-6 gap-y-3", className)}>
      {counts ? <Counters {...counts} /> : null}
      <Button
        type="button"
        onClick={onPublish}
        className="ml-auto h-10 rounded-[var(--r-md)] pl-3.5 pr-4 font-body text-[15px] font-medium"
      >
        <Plus aria-hidden="true" className="size-[18px]" strokeWidth={1.5} />
        Publish
      </Button>
    </div>
  );
}

function Counters({ kept, keptLimit, names, nameQuota, drafts }: UtilityCounts) {
  const atLimit = kept >= keptLimit;
  const keptShare = keptLimit > 0 ? Math.min(100, (kept / keptLimit) * 100) : 100;

  return (
    <div
      role="list"
      aria-label="Summary"
      className="flex flex-wrap items-center gap-x-5 gap-y-2 border-y border-border py-3 font-mono text-xs font-medium uppercase tracking-[0.08em] text-text-secondary"
    >
      <span role="listitem" className={cn("flex items-center gap-2", atLimit && "text-warning")}>
        Kept
        <span className={atLimit ? "text-warning" : "text-text"}>
          {kept} / {keptLimit}
        </span>
        <span aria-hidden="true" className="inline-flex h-0.5 w-10 overflow-hidden rounded-full bg-border">
          <span
            className={atLimit ? "bg-warning" : "bg-accent"}
            style={{ width: `${keptShare}%` }}
          />
        </span>
      </span>
      <Divider />
      <span role="listitem" className="flex gap-2">
        Names
        <span className="text-text">
          {names} / {nameQuota}
        </span>
      </span>
      {drafts > 0 ? (
        <>
          <Divider />
          <span role="listitem" className="flex gap-2">
            Drafts <span className="text-text">{drafts}</span>
          </span>
        </>
      ) : null}
    </div>
  );
}

function Divider() {
  return <span aria-hidden="true" className="h-3.5 w-px bg-border" />;
}
