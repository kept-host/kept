"use client";

/**
 * The mascot, animated in the browser.
 *
 * This is the `apps/web` consumer of `@kept/shared/mascot`. It owns nothing
 * about the character — no geometry, no face constants, no second copy of the
 * path maths. It owns exactly two things the generator deliberately cannot: a
 * clock, and a DOM to write onto.
 *
 * ── Frames go through refs, never through state ────────────────────────────
 * Writing each frame with `useState` would re-render this subtree sixty times a
 * second in order to change three attributes. The loop sets `d` and the eye
 * `transform`s directly on the nodes; React renders this component once.
 *
 * ── Reduced motion starts NO loop ──────────────────────────────────────────
 * Not a loop that ticks and throws its output away — that is a CPU cost with no
 * visible effect. Under `prefers-reduced-motion: reduce` the component paints
 * `MASCOT_REST_T` and stops, which is the same instant `apps/edge` freezes into
 * its system pages, so the resting character is identical in both places.
 *
 * CSS cannot serve this: the blink schedule is deliberately irregular (a
 * keyframe loop would regularise it) and the gaze drift needs per-frame values,
 * so there is no `@media (prefers-reduced-motion)` block that degrades it
 * gracefully. Hence a JS branch — and `startMascotLoop` below exists as a
 * separate, DOM-free function precisely so that branch can be *asserted*
 * (`lib/mascot/reduced-motion.test.ts`) rather than eyeballed.
 *
 * The media query is read **once**, matching `kept-engine.ts:353` in shape. A
 * mid-session toggle therefore does not take effect until reload; that is the
 * landing's existing behaviour, not a regression introduced here, and a
 * `change` listener would be one more thing to clean up for no product gain.
 *
 * ── Colour comes from tokens, not from this file ───────────────────────────
 * The body paints `currentColor`, so the caller picks it with a token class
 * (`text-accent`); the eyes paint `var(--bg)`, so they punch through to the
 * page and the character is theme-aware in both directions. The only literal
 * paint here is the mask's `white`, which is a mask luminance channel rather
 * than a colour — see the same note in `packages/shared/src/mascot/frame.ts`,
 * whose markup this mirrors so the two consumers cannot drift.
 */

import { useEffect, useId, useMemo, useRef } from "react";

import { MASCOT_REST_T, MASCOT_VIEWBOX, mascotFrame } from "@kept/shared/mascot";

/**
 * The mask region, in user space, taken from the generator's own viewBox rather
 * than restated — the two must agree or the eyes clip against a box that is not
 * the body's.
 */
const [MASK_X, MASK_Y, MASK_W, MASK_H] = MASCOT_VIEWBOX.split(" ");

/**
 * Paint the resting frame, then — unless motion is reduced — keep painting.
 *
 * Extracted from the component, and given its scheduler rather than reaching
 * for the global one, for one reason: it makes "under reduce we start no loop"
 * a property a test can hold, in a Node unit suite with no DOM. The alternative
 * — the branch inlined in the effect — can only be checked by rendering a
 * browser and counting `requestAnimationFrame` calls from an init script, and
 * the epic requires this asserted.
 *
 * The animated timeline *starts* at `MASCOT_REST_T`, so the first animated
 * frame is the resting frame: reduced and unreduced viewers see the same pose
 * on arrival and one of them then breathes.
 *
 * @returns the cleanup. It cancels whatever this call started, and under
 *   reduced motion it started nothing — so there is nothing left running,
 *   scheduled or listening once it has been invoked.
 */
export function startMascotLoop(
  reduced: boolean,
  paint: (t: number) => void,
  raf: (cb: (now: number) => void) => number,
  caf: (handle: number) => void,
): () => void {
  paint(MASCOT_REST_T);
  if (reduced) return () => undefined;

  let handle = 0;
  let origin = -1;
  const tick = (now: number) => {
    // The first callback's timestamp is the origin, so `t` never depends on
    // when the module was evaluated or how long hydration took.
    if (origin < 0) origin = now;
    paint(MASCOT_REST_T + (now - origin) / 1000);
    handle = raf(tick);
  };
  handle = raf(tick);
  return () => caf(handle);
}

export interface MascotProps {
  /**
   * Sizing and colour, as token classes — the component sets neither. The body
   * is `currentColor`, so `text-accent` is what makes it kept's accent, and the
   * `<svg>` has no intrinsic size beyond its viewBox's square aspect.
   */
  className?: string;
}

/**
 * `aria-hidden` decoration: it names nothing and labels nothing. The
 * `aria-hidden` that sits on the vessel's wrapper in `auth-shell.tsx` moves
 * onto this element rather than being dropped.
 */
export function Mascot({ className }: MascotProps) {
  // Not a literal: the moment a second mascot mounts — E06, or the landing —
  // two hardcoded ids would make both instances clip against whichever mask the
  // document parsed last.
  const maskId = useId();

  const bodyRef = useRef<SVGPathElement>(null);
  const maskPathRef = useRef<SVGPathElement>(null);
  const eyeARef = useRef<SVGPathElement>(null);
  const eyeBRef = useRef<SVGPathElement>(null);

  // The first paint is the resting frame, rendered rather than written: it is a
  // pure function of a constant, so the server and the client produce the same
  // attributes and there is no hydration mismatch and no unpainted flash.
  const rest = useMemo(() => mascotFrame(MASCOT_REST_T, { maskId }), [maskId]);

  useEffect(() => {
    const eyeRefs = [eyeARef, eyeBRef];
    const paint = (t: number) => {
      const { d, eyes } = mascotFrame(t, { maskId });
      bodyRef.current?.setAttribute("d", d);
      maskPathRef.current?.setAttribute("d", d);
      // `eyes` is always length 2 at kept's gaze (the generator's contract), so
      // one ref per eye holds for the life of the component and there is no
      // list to reconcile.
      eyeRefs.forEach((ref, i) => {
        const eye = eyes[i];
        const node = ref.current;
        if (!eye || !node) return;
        node.setAttribute("d", eye.d);
        node.setAttribute("transform", eye.transform);
      });
    };

    return startMascotLoop(
      // Read once, exactly as `kept-engine.ts:353` does. Inside the effect, so
      // render never touches `window`.
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      paint,
      (cb) => window.requestAnimationFrame(cb),
      (handle) => window.cancelAnimationFrame(handle),
    );
  }, [maskId]);

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={MASCOT_VIEWBOX}
      className={className}
    >
      {/* The body is drawn twice — once filled, once into the mask — so the
          eyes clip to the silhouette instead of hanging off its edge. */}
      <mask
        id={maskId}
        maskUnits="userSpaceOnUse"
        x={MASK_X}
        y={MASK_Y}
        width={MASK_W}
        height={MASK_H}
      >
        <path ref={maskPathRef} d={rest.d} fill="white" />
      </mask>
      <path ref={bodyRef} d={rest.d} fill="currentColor" />
      <g mask={`url(#${maskId})`} fill="var(--bg)">
        <path ref={eyeARef} d={rest.eyes[0]?.d} transform={rest.eyes[0]?.transform} />
        <path ref={eyeBRef} d={rest.eyes[1]?.d} transform={rest.eyes[1]?.transform} />
      </g>
    </svg>
  );
}
