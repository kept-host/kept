import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { noSearchResults } from "@/lib/sites/display";

/**
 * A tab with nothing to show — the Pages home's calm line, not its first-visit
 * hero (that is `EmptyState`, for an account with no pages at all). The
 * dashed box is the search no-results block's, which this generalises.
 */
export function TabEmpty({
  title,
  note,
  action,
  testId,
}: {
  title: string;
  note: string;
  /** One way out — clear the search, show every draft. */
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col items-center gap-2 rounded-[var(--r-lg)] border border-dashed border-border px-6 py-12 text-center"
    >
      <p className="font-display text-xl font-semibold tracking-[-0.02em] text-text">{title}</p>
      <p className="text-[15px] text-text-secondary">{note}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** The search matched nothing on this tab. */
export function NoSearchResults({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <TabEmpty
      title={noSearchResults(query)}
      note="Try another word, or clear the search."
      action={
        <Button type="button" variant="secondary" size="sm" onClick={onClear} className="font-body font-medium">
          Clear search
        </Button>
      }
    />
  );
}
