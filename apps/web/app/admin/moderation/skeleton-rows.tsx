import { Skeleton } from "@/components/ui/skeleton";

/** A tab while its rows load (§9): never blank. */
export function SkeletonRows() {
  return (
    <div data-testid="moderation-loading" aria-busy="true" className="flex flex-col gap-2">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}
