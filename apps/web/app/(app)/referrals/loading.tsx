/** `/referrals` while its read is in flight — the screen's shape, no numbers. */
import { Skeleton } from "@/components/ui/skeleton";

const ROWS = ["a", "b", "c"];

export default function ReferralsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading your referrals" className="flex max-w-[760px] flex-col gap-6 px-4 pb-24 pt-8 md:px-10">
      <Skeleton className="h-10 w-44" />
      <div className="flex flex-col gap-3.5 rounded-[var(--r-lg)] border border-border bg-surface p-5">
        <Skeleton className="h-4 w-72 rounded-[4px]" />
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-2">
          <Skeleton className="h-11 rounded-[var(--r-sm)]" />
          <Skeleton className="h-11 rounded-[var(--r-sm)]" />
        </div>
        <Skeleton className="h-8 w-40" />
        {ROWS.map((key) => (
          <div key={key} className="flex items-center gap-3 border-t border-border py-2.5">
            <Skeleton className="size-7 rounded-full" />
            <Skeleton className="h-3 flex-1 rounded-[4px]" />
            <Skeleton className="h-3 w-16 rounded-[4px]" />
          </div>
        ))}
      </div>
    </div>
  );
}
