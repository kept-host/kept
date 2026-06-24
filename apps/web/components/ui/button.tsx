import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * kept button — shadcn behavior, kept skin. Tokens only.
 *  - primary:  bg-accent + ink-safe white text, press scale-98
 *  - secondary: border + text, sunken hover
 *  - ghost: text only
 *  - link: bespoke MONO text-link (JetBrains Mono, underline) — the
 *    `↑ Drop a file or browse` control (frontend-specs §4).
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-display font-semibold transition-all duration-150 ease-[var(--ease-out)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-white shadow-[var(--shadow-sm)] hover:bg-accent-hover active:scale-[0.98] rounded-[var(--r-md)]",
        secondary:
          "border border-border bg-surface text-text hover:bg-sunken active:scale-[0.98] rounded-[var(--r-md)]",
        ghost:
          "text-text hover:bg-sunken active:scale-[0.98] rounded-[var(--r-md)]",
        destructive:
          "bg-danger text-white hover:opacity-90 active:scale-[0.98] rounded-[var(--r-md)]",
        link: "font-mono text-sm font-medium uppercase tracking-[0.08em] text-accent underline underline-offset-4 hover:text-accent-hover",
      },
      size: {
        sm: "h-9 px-3 text-sm",
        default: "h-11 px-5 text-sm",
        lg: "h-12 px-7 text-base",
        icon: "size-11",
      },
    },
    compoundVariants: [
      // The mono text-link ignores box sizing — it is a control, not a button box.
      { variant: "link", size: "default", className: "h-auto px-0" },
      { variant: "link", size: "sm", className: "h-auto px-0" },
      { variant: "link", size: "lg", className: "h-auto px-0" },
    ],
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
