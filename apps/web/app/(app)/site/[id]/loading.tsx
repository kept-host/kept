/**
 * `/site/[id]` while its reads are in flight — PRD §9.2 "loading skeleton".
 *
 * SKELETONS IN THE SHAPE OF THE REAL LAYOUT (`kept Page Screen.dc.html`): the
 * top bar, the title row, the preview column with its link chip, and the
 * settings column with its tab strip and two cards — so nothing jumps when the
 * page arrives. No name, no status: a skeleton must not guess either.
 */
import { Skeleton } from "@/components/ui/skeleton";

import { TOP_BAR } from "./back-link";

export default function SiteDetailLoading() {
  return (
    <div aria-busy="true" aria-label="Loading this page">
      <div className={TOP_BAR}>
        <Skeleton className="h-6 w-24 rounded-[var(--r-sm)]" />
      </div>

      <div className="flex flex-col gap-6 px-4 pt-7 pb-24 @container md:px-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <Skeleton className="h-10 w-72 max-w-full" />
          <Skeleton className="h-8 w-32 rounded-[var(--r-pill)]" />
        </div>

        <div className="flex flex-col gap-8 @min-[860px]:grid @min-[860px]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] @min-[860px]:items-start">
          <div className="flex min-w-0 flex-col gap-3">
            <Skeleton className="h-11 rounded-[var(--r-pill)]" />
            <Skeleton className="h-[420px] rounded-[var(--r-lg)] max-md:h-48" />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <Skeleton className="h-11 rounded-[var(--r-md)]" />
            <Skeleton className="h-48 rounded-[var(--r-lg)]" />
            <Skeleton className="h-36 rounded-[var(--r-lg)]" />
          </div>
        </div>
      </div>
    </div>
  );
}
