import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-11 w-full rounded-[var(--r-md)] border border-border bg-surface px-3.5 py-2 text-sm text-text shadow-[var(--shadow-sm)] transition-colors duration-150",
        "placeholder:text-text-muted",
        "focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-text",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
