"use client";

/**
 * The bar under "Packing {n} files…" / "Uploading {size}…" (E08 §8) — the mint
 * card's and the Versions tab's. The line itself is `progressNotice`'s; this
 * draws how far it has got.
 */
import { progressNotice, type UploadProgress } from "@/lib/sites/owner-upload";
import { cn } from "@/lib/utils";

export function UploadProgressBar({ progress, className }: { progress: UploadProgress; className?: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, progress.fraction)) * 100);
  return (
    <div
      role="progressbar"
      data-testid="upload-progress"
      data-phase={progress.phase}
      aria-label={progressNotice(progress)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={cn("h-1 w-full overflow-hidden rounded-[var(--r-pill)] bg-sunken", className)}
    >
      <div
        className="h-full rounded-[var(--r-pill)] bg-accent motion-safe:transition-[width] motion-safe:duration-150"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
