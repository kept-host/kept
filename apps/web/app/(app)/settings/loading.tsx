/**
 * Settings while its reads are in flight — PRD §9.3 ("per-section skeleton").
 *
 * In the shape of the real screen so nothing jumps: the phone's top bar, the
 * title, the four section entries, and the Account section's two cards (it is
 * the one that opens first) — an email field, and the three sign-in method rows.
 * No email, no counts: a skeleton must not guess.
 */
import { Skeleton } from "@/components/ui/skeleton";

const NAV = ["a", "b", "c", "d"];
const METHODS = ["a", "b", "c"];

export default function SettingsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading your settings">
      <div className="flex h-16 items-center border-b border-border px-4 md:hidden">
        <Skeleton className="h-6 w-16 rounded-[var(--r-sm)]" />
      </div>

      <div className="flex max-w-[1040px] flex-col gap-6 px-4 pb-24 pt-8 md:px-10">
        <Skeleton className="h-10 w-40" />

        <div className="flex flex-wrap items-start gap-x-10 gap-y-6">
          <div className="flex shrink-0 basis-full gap-0.5 md:basis-[200px] md:flex-col">
            {NAV.map((key) => (
              <Skeleton key={key} className="h-10 w-24 rounded-[var(--r-sm)] md:w-full" />
            ))}
          </div>

          <div className="flex min-w-0 flex-[1_1_480px] flex-col gap-4">
            <div className="flex flex-col gap-4 rounded-[var(--r-lg)] border border-border bg-surface p-5">
              <Skeleton className="h-6 w-28 rounded-[var(--r-sm)]" />
              <Skeleton className="h-11 w-full rounded-[var(--r-sm)]" />
              <Skeleton className="h-10 w-28" />
            </div>

            <div className="flex flex-col gap-1 rounded-[var(--r-lg)] border border-border bg-surface p-5">
              <Skeleton className="mb-3 h-6 w-40 rounded-[var(--r-sm)]" />
              {METHODS.map((key) => (
                <div key={key} className="flex items-center gap-3 border-t border-border py-3">
                  <Skeleton className="size-9 shrink-0 rounded-[var(--r-sm)]" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <Skeleton className="h-3 w-24 rounded-[4px]" />
                    <Skeleton className="h-2.5 w-36 rounded-[4px]" />
                  </div>
                  <Skeleton className="h-9 w-24" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
