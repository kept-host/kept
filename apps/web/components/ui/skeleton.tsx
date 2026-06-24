import { cn } from "@/lib/utils";

/** kept skeleton — sunken token surface, animate-pulse. Loading is never blank (§10). */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-[var(--r-md)] bg-sunken", className)}
      {...props}
    />
  );
}

export { Skeleton };
