/**
 * The dashboard while its one query is in flight — E06 task 003.
 *
 * CARD-SHAPED, NOT A SPINNER. A spinner says "something is happening"; this says
 * "your pages are arriving, and there will be a header, two sections and a grid
 * of cards" — so the layout does not jump when they do. `components/ui/skeleton`
 * has existed unused since E00 and this is what it was for.
 *
 * NO COUNTS AND NO CLOCK. A skeleton must not guess how many pages the account
 * has or imply a countdown it cannot know; three placeholders per section read
 * as "a grid", not as a number.
 */
import { Skeleton } from "@/components/ui/skeleton";

const PLACEHOLDERS = ["a", "b", "c"];

export default function DashboardLoading() {
  return (
    <main
      // The screen reader hears one sentence instead of a rubble of empty boxes.
      aria-busy="true"
      aria-label="Loading your pages"
      className="mx-auto w-full max-w-[1100px] px-6 pb-28 pt-12 md:px-8 md:pt-16"
    >
      <header className="border-b border-border pb-8">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-4 h-11 w-64" />
        <Skeleton className="mt-6 h-7 w-36 rounded-[var(--r-pill)]" />
      </header>

      <SectionSkeleton titleWidth="w-20" />
      <SectionSkeleton titleWidth="w-24" />
    </main>
  );
}

function SectionSkeleton({ titleWidth }: { titleWidth: string }) {
  return (
    <section className="mt-14">
      <div className="flex items-baseline gap-4 border-b border-border pb-3">
        <Skeleton className={`h-6 ${titleWidth}`} />
        <Skeleton className="h-3 w-16" />
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PLACEHOLDERS.map((key) => (
          <CardSkeleton key={key} />
        ))}
      </div>
    </section>
  );
}

/** The same box the real card draws, with its four rows blocked out. */
function CardSkeleton() {
  return (
    <div className="flex flex-col gap-4 rounded-[var(--r-lg)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <Skeleton className="h-4 w-24 rounded-[var(--r-pill)]" />
      <div>
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="mt-2 h-3 w-1/2" />
      </div>
      <div className="mt-auto flex items-end justify-between gap-3 border-t border-border pt-3">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-8 w-28" />
      </div>
    </div>
  );
}
