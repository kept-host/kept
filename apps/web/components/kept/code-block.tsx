"use client";

import { CopyButton } from "@/components/kept/live-url";

/**
 * A copyable code block: JetBrains Mono on the sunken surface, with a Copy
 * button whose accessible name says what it copies. `/agents` (E09 task 004)
 * and Settings' agent cards and new-key dialog (task 006) share it.
 */
export function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-sunken p-3">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-text">
        {code}
      </pre>
      <CopyButton
        text={code}
        label={
          <>
            Copy<span className="sr-only"> {label}</span>
          </>
        }
        size="sm"
        variant="secondary"
        className="shrink-0"
      />
    </div>
  );
}
