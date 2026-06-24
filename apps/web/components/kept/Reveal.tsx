"use client";

import * as React from "react";
import { motion, useReducedMotion, type Variants } from "motion/react";

/**
 * Reveal — calm, orchestrated scroll-in motion (frontend-specs §6).
 *
 * A thin wrapper over `motion.div` that fades + lifts content into view once,
 * on a deliberate `--ease-out` curve. Children that should stagger are wrapped
 * in their own <Reveal> with an incremental `delay`, OR a parent <Reveal as
 * container> staggers its <RevealItem> children automatically.
 *
 * Reduced-motion users get the content immediately (no transform, no opacity
 * ramp) — the element renders in its final state with animation disabled.
 */

const EASE_OUT = [0.2, 0, 0, 1] as const;

const containerVariants: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.08, delayChildren: 0.04 } },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 22 },
  shown: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.7, ease: EASE_OUT },
  },
};

type MotionDivProps = Omit<React.ComponentProps<typeof motion.div>, "children">;

type RevealProps = MotionDivProps & {
  children?: React.ReactNode;
  /** Extra delay (s) before this block animates in. */
  delay?: number;
  /** Travel distance (px) for the lift. */
  distance?: number;
};

/** A single block that fades + lifts in once when scrolled into view. */
export function Reveal({
  children,
  delay = 0,
  distance = 22,
  className,
  ...rest
}: RevealProps) {
  const reduced = useReducedMotion();

  if (reduced) {
    return (
      <div className={className} {...(rest as React.HTMLAttributes<HTMLDivElement>)}>
        {children}
      </div>
    );
  }

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: distance }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3, margin: "0px 0px -10% 0px" }}
      transition={{ duration: 0.7, ease: EASE_OUT, delay }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/**
 * RevealGroup — a container that staggers its <RevealItem> children. Use for
 * card grids / lists so items cascade in rather than popping together.
 */
export function RevealGroup({
  children,
  className,
  amount = 0.2,
  ...rest
}: MotionDivProps & { children?: React.ReactNode; amount?: number }) {
  const reduced = useReducedMotion();

  if (reduced) {
    return (
      <div className={className} {...(rest as React.HTMLAttributes<HTMLDivElement>)}>
        {children}
      </div>
    );
  }

  return (
    <motion.div
      className={className}
      variants={containerVariants}
      initial="hidden"
      whileInView="shown"
      viewport={{ once: true, amount }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/** A child of <RevealGroup> that participates in the parent's stagger. */
export function RevealItem({
  children,
  className,
  ...rest
}: MotionDivProps & { children?: React.ReactNode }) {
  const reduced = useReducedMotion();

  if (reduced) {
    return (
      <div className={className} {...(rest as React.HTMLAttributes<HTMLDivElement>)}>
        {children}
      </div>
    );
  }

  return (
    <motion.div className={className} variants={itemVariants} {...rest}>
      {children}
    </motion.div>
  );
}
