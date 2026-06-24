import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/** kept badge — mono uppercase micro-label by default; status variants use tokens. */
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-[var(--r-pill)] border px-2.5 py-0.5 font-mono text-[0.6875rem] font-medium uppercase tracking-[0.08em] transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-accent-soft text-accent",
        outline: "border-border bg-transparent text-text-secondary",
        live: "border-transparent bg-[color-mix(in_srgb,var(--live)_15%,transparent)] text-live",
        warning:
          "border-transparent bg-[color-mix(in_srgb,var(--warning)_15%,transparent)] text-warning",
        danger:
          "border-transparent bg-[color-mix(in_srgb,var(--danger)_15%,transparent)] text-danger",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";
  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
