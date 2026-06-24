"use client";

import * as React from "react";
import {
  useScroll,
  useTransform,
  useMotionValueEvent,
  useReducedMotion,
  motion,
  type MotionValue,
} from "motion/react";

import { VesselMount } from "@/components/kept/VesselMount";
import { useVesselState } from "@/components/kept/vessel-state";

/**
 * VesselScrollStage — the pinned scroll choreography (Phase 2).
 *
 * A tall relative stage wrapping the hero + the following content sections. The
 * Vessel Canvas lives in a single `sticky` pinned layer so it STAYS MOUNTED and
 * in view while content scrolls past it, then releases naturally when the stage
 * ends (before the gauge/footer). One `useScroll` against the stage produces
 * `scrollYProgress`, which is:
 *
 *   1. pushed into VesselState via `setScrollProgress` (rAF-throttled, so React
 *      never thrashes) — the R3F scene eases this into rotation.y/x + glow.
 *   2. mapped to the pinned layer's drift (translateY / scale) and to a violet
 *      ambient glow layer that bleeds DOWN the page, appearing to illuminate the
 *      upcoming sections as the vessel passes.
 *
 * Reduced-motion: no scroll scrub (scrollProgress stays 0), the vessel renders
 * its settled frame, the glow sits static and faint, no drift. The children are
 * always fully visible — this only adds an ambient layer + a pinned canvas.
 */

const EASE_OUT = [0.2, 0, 0, 1] as const;

/** rAF-throttled bridge: scrollYProgress → VesselState.setScrollProgress. */
function useScrollToVessel(scrollYProgress: MotionValue<number>, enabled: boolean) {
  const { setScrollProgress } = useVesselState();
  const frame = React.useRef<number | null>(null);
  const pending = React.useRef(0);

  useMotionValueEvent(scrollYProgress, "change", (latest) => {
    if (!enabled) return;
    pending.current = latest;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setScrollProgress(pending.current);
    });
  });

  React.useEffect(() => {
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);
}

export function VesselScrollStage({ children }: { children: React.ReactNode }) {
  const reduced = useReducedMotion();
  const stageRef = React.useRef<HTMLDivElement>(null);

  // Progress of the stage through the viewport: 0 when the stage top hits the
  // viewport top, 1 when the stage bottom reaches the viewport bottom.
  const { scrollYProgress } = useScroll({
    target: stageRef,
    offset: ["start start", "end end"],
  });

  useScrollToVessel(scrollYProgress, !reduced);

  // Pinned vessel drift: settles down + scales subtly as the page advances, then
  // eases away near the release point so the hand-off to the gauge feels intended.
  const vesselY = useTransform(scrollYProgress, [0, 0.5, 1], [0, 28, -8]);
  const vesselScale = useTransform(scrollYProgress, [0, 0.6, 1], [1, 0.96, 0.9]);
  const vesselOpacity = useTransform(
    scrollYProgress,
    [0, 0.82, 0.98],
    [1, 1, 0.35],
  );

  // Ambient glow: drifts DOWN the page (the orb's light bleeding onto the next
  // sections) and intensifies through the middle of the journey, then recedes.
  const glowY = useTransform(scrollYProgress, [0, 1], ["8%", "78%"]);
  const glowOpacity = useTransform(
    scrollYProgress,
    [0, 0.18, 0.55, 0.9],
    [0.32, 0.6, 0.9, 0.4],
  );
  const glowScale = useTransform(scrollYProgress, [0, 0.55, 1], [1, 1.25, 1.05]);

  return (
    <div ref={stageRef} className="relative">
      {/* ── Ambient violet glow that follows scroll, BEHIND all content ── */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-0 h-full"
        style={reduced ? undefined : { opacity: glowOpacity }}
      >
        <motion.div
          className="sticky top-0 mx-auto h-screen w-full max-w-[1280px] px-6 md:px-12"
          style={
            reduced
              ? undefined
              : { y: glowY, scale: glowScale, willChange: "transform" }
          }
        >
          {/* right-biased pool tracking the vessel column, blended over the bg */}
          <div
            className="absolute right-[4%] top-1/2 h-[64vmin] w-[64vmin] -translate-y-1/2 rounded-full blur-[80px] md:right-[12%]"
            style={{
              background:
                "radial-gradient(circle at center, color-mix(in srgb, var(--accent) 34%, transparent), transparent 68%)",
              opacity: reduced ? 0.4 : 1,
            }}
          />
        </motion.div>
      </motion.div>

      {/* ── The pinned, persistently-mounted Vessel canvas (behind content) ── */}
      <div className="pointer-events-none absolute inset-0 z-0">
        <motion.div
          className="sticky top-[72px] flex h-[calc(100vh-72px)] items-center px-6 md:px-12"
          style={
            reduced
              ? undefined
              : {
                  y: vesselY,
                  scale: vesselScale,
                  opacity: vesselOpacity,
                  willChange: "transform",
                }
          }
        >
          <div className="mx-auto w-full max-w-[1280px]">
            {/* Right-column placement mirrors the hero grid (≈0.88fr of 2fr). */}
            <div className="pointer-events-auto mx-auto w-[78%] max-w-[440px] md:ml-auto md:mr-0 md:w-[44%]">
              <VesselMount />
            </div>
          </div>
        </motion.div>
      </div>

      {/* ── Scrolling content (hero copy + the next sections) over the vessel ── */}
      <div className="relative z-[2]">{children}</div>
    </div>
  );
}

export { EASE_OUT };
