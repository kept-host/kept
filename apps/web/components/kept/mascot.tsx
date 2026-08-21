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
 * ── The eyes follow the pointer ────────────────────────────────────────────
 * `pointermove` on `window` (not on the `<svg>`: an 96 px square is a target
 * nobody hits, and the whole point is that it notices you before you reach it).
 * The position goes to a local, never to state — a `setState` per mouse move
 * would re-render this subtree at the sample rate of the mouse. The element's
 * own rect is measured once and re-measured on `resize`/`scroll` only, so no
 * frame and no move forces layout, and the offset is normalised and handed to
 * `gazeToward`, which clamps it to the envelope that keeps both eyes clear of
 * the silhouette. The gaze then *eases* toward that target — see
 * `MASCOT_GAZE_K` — because a gaze that arrives instantly reads as the eyes
 * being welded to the cursor rather than as something looking at you.
 *
 * ── Reduced motion starts NO loop, and NO listener ─────────────────────────
 * Not a loop that ticks and throws its output away — that is a CPU cost with no
 * visible effect. Under `prefers-reduced-motion: reduce` the component paints
 * `MASCOT_REST_T` and stops, which is the same instant `apps/edge` freezes into
 * its system pages, so the resting character is identical in both places. It
 * also never registers the pointer listener; the CSS bob is gated by the same
 * query in `globals.css`. The elevation shadow at the call site stays — it is
 * static, and reduced motion is about movement, not about flatness.
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

import {
  type HeadGaze,
  KEPT_REST_GAZE,
  MASCOT_REST_T,
  MASCOT_VIEWBOX,
  gazeToward,
  mascotFrame,
} from "@kept/shared/mascot";

/**
 * The mask region, in user space, taken from the generator's own viewBox rather
 * than restated — the two must agree or the eyes clip against a box that is not
 * the body's.
 */
const [MASK_X, MASK_Y, MASK_W, MASK_H] = MASCOT_VIEWBOX.split(" ");

/**
 * How fast the gaze catches up to the pointer, as the rate constant of an
 * exponential approach: each frame moves `1 - Math.exp(-k * dt)` of the way
 * there, so the ease is identical at 60 Hz, 120 Hz and on a dropped frame. A
 * fixed per-frame lerp is not — it eases twice as fast on a 120 Hz display,
 * which is exactly the machine most likely to be watched.
 *
 * `k = 6` is a ~170 ms time constant: the eyes are most of the way there in
 * about a third of a second. Picked by looking at it in the browser, at
 * `size-24`, against a pointer crossing the whole viewport — 12 is quick enough
 * to read as a snap and loses the sense that something is *following* you; 3
 * lags far enough behind a fast sweep to read as sluggish rather than calm.
 */
const MASCOT_GAZE_K = 6;

/**
 * How far the pointer travels before the gaze saturates, in multiples of the
 * mascot's own half-width.
 *
 * Normalising against the half-width alone (reach 1) would peg the eyes at the
 * envelope for every pointer position more than ~48 px away at `size-24`, which
 * is almost the whole screen: the tracking would be invisible and the character
 * would just stare at the nearest corner. 8 puts saturation ~380 px out, so a
 * pointer sweeping a laptop viewport spends its travel in the moving range and
 * only the far edges sit at the limit. Scaling by the element rather than by a
 * pixel constant means a larger mascot looks correspondingly further.
 */
const MASCOT_GAZE_REACH = 8;

/**
 * Paint the resting frame, then — unless motion is reduced — keep painting, and
 * keep the eyes pointed at whatever `track` is aiming them at.
 *
 * Extracted from the component, and given its scheduler rather than reaching
 * for the global one, for one reason: it makes "under reduce we start no loop"
 * a property a test can hold, in a Node unit suite with no DOM. The alternative
 * — the branch inlined in the effect — can only be checked by rendering a
 * browser and counting `requestAnimationFrame` calls from an init script, and
 * the epic requires this asserted. `track` is here for the same reason and
 * under the same constraint: "under reduce we register no pointer listener"
 * is a property, not a code review, so the subscription is a parameter and the
 * reduced branch returns before ever calling it. It is the component that owns
 * the DOM half — measuring the element, and dividing by its size.
 *
 * The animated timeline *starts* at `MASCOT_REST_T`, so the first animated
 * frame is the resting frame: reduced and unreduced viewers see the same pose
 * on arrival and one of them then breathes.
 *
 * @param track subscribes to the pointer. It is handed an `aim` callback taking
 *   an offset from the mascot's centre normalised to roughly [-1, 1], and
 *   returns its own unsubscribe. Called at most once, and never under reduce.
 * @returns the cleanup. It cancels whatever this call started, and under
 *   reduced motion it started nothing — so there is nothing left running,
 *   scheduled or listening once it has been invoked.
 */
export function startMascotLoop(
  reduced: boolean,
  paint: (t: number, gaze: HeadGaze) => void,
  raf: (cb: (now: number) => void) => number,
  caf: (handle: number) => void,
  track: (aim: (nx: number, ny: number) => void) => () => void,
): () => void {
  paint(MASCOT_REST_T, KEPT_REST_GAZE);
  if (reduced) return () => undefined;

  // Where the eyes are being asked to look, and where they actually are. Both
  // are plain locals rather than refs: the loop is the only reader.
  let target = KEPT_REST_GAZE;
  let gaze = KEPT_REST_GAZE;
  const untrack = track((nx, ny) => {
    target = gazeToward(nx, ny);
  });

  let handle = 0;
  let origin = -1;
  let last = 0;
  const tick = (now: number) => {
    // The first callback's timestamp is the origin, so `t` never depends on
    // when the module was evaluated or how long hydration took.
    if (origin < 0) {
      origin = now;
      last = now;
    }
    // Clamped, so returning to a backgrounded tab resumes the ease instead of
    // teleporting the eyes through it.
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const step = 1 - Math.exp(-MASCOT_GAZE_K * dt);
    gaze = {
      yaw: gaze.yaw + (target.yaw - gaze.yaw) * step,
      pitch: gaze.pitch + (target.pitch - gaze.pitch) * step,
      // `gazeToward` passes roll through untouched, so this never moves; taking
      // it from the target keeps the two in step if that ever changes.
      roll: target.roll,
    };
    paint(MASCOT_REST_T + (now - origin) / 1000, gaze);
    handle = raf(tick);
  };
  handle = raf(tick);
  return () => {
    untrack();
    caf(handle);
  };
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
 * `aria-hidden` decoration: it names nothing and labels nothing. It carries the
 * attribute on its own `<svg>` root rather than relying on a wrapper at the
 * call site — the illustration this replaced in `auth-shell.tsx` was hidden by
 * a wrapper `<div>`, and moving the attribute onto the element itself means no
 * future mount site can drop it by forgetting one.
 */
export function Mascot({ className }: MascotProps) {
  // Not a literal: the moment a second mascot mounts — E06, or the landing —
  // two hardcoded ids would make both instances clip against whichever mask the
  // document parsed last.
  const maskId = useId();

  const rootRef = useRef<SVGSVGElement>(null);
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
    const paint = (t: number, gaze: HeadGaze) => {
      const { d, eyes } = mascotFrame(t, { maskId, gaze });
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

    /**
     * The DOM half of the tracking: measure the element, watch the pointer,
     * hand the loop a normalised offset. Registered only if the loop asks —
     * which under reduced motion it does not.
     *
     * The rect is cached and refreshed on `resize` and `scroll` rather than
     * read per move or per frame: `getBoundingClientRect` forces layout, and
     * doing that inside a `pointermove` on a page that is otherwise idle is the
     * one way this feature could cost anything measurable.
     */
    const track = (aim: (nx: number, ny: number) => void) => {
      let rect = rootRef.current?.getBoundingClientRect() ?? null;
      let clientX = 0;
      let clientY = 0;
      let seen = false;

      const send = () => {
        // Zero-size rect: hidden, unmounted mid-flight, or measured before
        // layout. Dividing by it yields 0/0 = NaN, and `gazeToward` propagates
        // NaN straight into the transform matrix, which blanks the face. (0, 0)
        // is exactly `KEPT_REST_GAZE`, so the fallback is the resting pose.
        if (!seen || !rect || rect.width <= 0 || rect.height <= 0) {
          aim(0, 0);
          return;
        }
        const reachX = (rect.width / 2) * MASCOT_GAZE_REACH;
        const reachY = (rect.height / 2) * MASCOT_GAZE_REACH;
        aim(
          (clientX - (rect.left + rect.width / 2)) / reachX,
          (clientY - (rect.top + rect.height / 2)) / reachY,
        );
      };

      const remeasure = () => {
        rect = rootRef.current?.getBoundingClientRect() ?? null;
        send();
      };
      const onPointerMove = (e: PointerEvent) => {
        clientX = e.clientX;
        clientY = e.clientY;
        seen = true;
        send();
      };

      window.addEventListener("pointermove", onPointerMove, { passive: true });
      window.addEventListener("resize", remeasure, { passive: true });
      window.addEventListener("scroll", remeasure, { passive: true });
      return () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("resize", remeasure);
        window.removeEventListener("scroll", remeasure);
      };
    };

    return startMascotLoop(
      // Read once, exactly as `kept-engine.ts:353` does. Inside the effect, so
      // render never touches `window`.
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      paint,
      (cb) => window.requestAnimationFrame(cb),
      (handle) => window.cancelAnimationFrame(handle),
      track,
    );
  }, [maskId]);

  return (
    <svg
      ref={rootRef}
      aria-hidden="true"
      focusable="false"
      // The hover hook. Size and colour are the caller's (task 003), but the
      // idle bob is intrinsic to the character — the same reason the blink
      // schedule is not a prop — so the component carries it and `globals.css`
      // gates it behind `prefers-reduced-motion: no-preference`. It is a CSS
      // transform on this element and never a change to `cy` or to the path:
      // `MASCOT_BODY_R = 85` against a 1.157 profile peak leaves ~1.6 viewBox
      // units of headroom, so bobbing inside the viewBox clips the silhouette.
      data-mascot=""
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
