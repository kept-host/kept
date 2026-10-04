/**
 * The Pages home while its read is in flight — PRD §9.1 (`kept Studio
 * Screen.dc.html`, `view: loading`).
 *
 * SKELETONS IN THE SHAPE OF THE REAL LAYOUT: the top bar, the title, the
 * counters rule, a drafts row and six wall cards — so nothing jumps when the
 * pages arrive. No numbers and no clock: a skeleton must not guess how many
 * pages the account has.
 */
import { Skeleton } from "@/components/ui/skeleton";

const DRAFTS = ["a", "b", "c"];
const CARDS = ["a", "b", "c", "d", "e", "f"];

export default function DashboardLoading() {
  return (
    <div aria-busy="true" aria-label="Loading your pages">
      <div className="flex h-16 items-center gap-3 border-b border-border px-4 md:px-8">
        <Skeleton className="h-10 w-full max-w-[420px] rounded-[var(--r-sm)]" />
      </div>

      <div className="flex flex-col gap-7 px-4 pb-24 pt-8 @container md:px-10">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-10 w-56" />
          <div className="flex h-11 items-center gap-5 border-y border-border">
            <Skeleton className="h-2.5 w-[120px] rounded-[4px]" />
            <Skeleton className="h-2.5 w-20 rounded-[4px]" />
            <Skeleton className="h-2.5 w-[110px] rounded-[4px]" />
          </div>
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,250px),1fr))] gap-3">
          {DRAFTS.map((key) => (
            <div key={key} className="h-[150px] overflow-hidden rounded-[var(--r-lg)] border border-border bg-surface">
              <Skeleton className="h-[88px] rounded-none" />
              <div className="flex flex-col gap-2 p-3.5">
                <Skeleton className="h-[11px] w-[55%] rounded-[4px]" />
                <Skeleton className="h-[9px] w-3/4 rounded-[4px]" />
              </div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(clamp(150px,22cqw,280px),1fr))] gap-[clamp(12px,2.5cqw,20px)]">
          {CARDS.map((key) => (
            <div key={key} className="overflow-hidden rounded-[var(--r-lg)] border border-border bg-surface">
              <Skeleton className="aspect-[16/10] rounded-none" />
              <div className="flex flex-col gap-2 p-3.5">
                <Skeleton className="h-3 w-3/5 rounded-[4px]" />
                <Skeleton className="h-2.5 w-4/5 rounded-[4px]" />
                <Skeleton className="mt-1.5 h-2.5 w-[35%] rounded-[4px]" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
