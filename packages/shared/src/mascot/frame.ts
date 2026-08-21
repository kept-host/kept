// kept mascot — one instant of the character, and the API both consumers call.
//
// ─── Attribution ────────────────────────────────────────────────────────────
// Derived from **bloub** — https://github.com/jeremy-prt/bloub
// Copyright © 2026 Jérémy Perret. Released under the MIT licence.
// Full licence text: `THIRD-PARTY.md` at the repository root.
//
// Read at commit b4bb3c1b5f93c7b87a2e8d620f667c4093d97749 (2026-08-17),
// file `src/bot/engine.ts` (the per-frame assembly only).
//
// TAKEN — generic engineering, no brand identity in it:
//   · the assembly order of a frame: liveliness → silhouette → body path →
//     re-seat each eye onto the real contour with `radiusAtAngle` → compose the
//     eye's own tilt with the tangent basis → apply the blink LAST, as a
//     vertical squash in screen space;
//   · emitting the eyes as one shared path plus a per-eye `matrix(...)`.
//
// NOT TAKEN — **no measured profile and no measured face constant was copied.**
// bloub's shape library, its state machine, its expression editor, its decor
// layer and its build-time eye-fit solver are all absent; kept has one shape
// and one expression, so every one of them would be dead code. The single
// hand-tuned `KEPT_EYE_INSET` in `face.ts` replaces the solver.
// ────────────────────────────────────────────────────────────────────────────
//
// Pure and platform-free by contract: no browser global, no DOM API, no Node
// built-in. `mascotSvg` returns a STRING — that is what lets the Cloudflare
// Worker in `apps/edge` render the character at all.
//
// **No hex, anywhere.** The body paints `currentColor` so the caller picks it
// with a token class; the eyes paint `var(--bg)` so they punch through to the
// page and the character is theme-aware in both directions. The mask needs an
// opaque paint and uses the CSS keyword `white`, which is a mask channel, not a
// brand colour.

import {
  BODY_PROFILE,
  MASCOT_SAMPLES,
  MASCOT_SQUIRCLE_N,
  type Point,
  type Silhouette,
  blend,
  closedPath,
  lerp,
  normalize,
  r2,
  radiusAtAngle,
  superellipseProfile,
  toPoints,
} from "./geometry";
import {
  type HeadGaze,
  KEPT_EYE_INSET,
  KEPT_EYE_SPLIT,
  KEPT_EYE_TILT,
  KEPT_REST_GAZE,
  blinkScale,
  eyePoses,
  keptEyePath,
  liveliness,
} from "./face";

/**
 * The square the character is drawn into. The aspect ratio is intrinsic to the
 * viewBox now, which is why the Worker's `aspect-ratio` guard goes away.
 */
const VIEW_HALF = 100;
export const MASCOT_VIEWBOX = `${-VIEW_HALF} ${-VIEW_HALF} ${VIEW_HALF * 2} ${VIEW_HALF * 2}`;

/**
 * The body radius in viewBox units.
 *
 * Not 100: `BODY_PROFILE` peaks at 1.15 on the squircle's diagonal (that 1.15
 * is load-bearing — see `normalize` in `geometry.ts`), and the body drifts by
 * up to 0.007 of a radius. 85 × 1.157 ≈ 98.4, so the character never touches
 * the viewBox edge at any `t` and no consumer needs an overflow rule.
 */
export const MASCOT_BODY_R = 85;

/**
 * The inhale silhouette: the same superellipse equation at a rounder exponent.
 *
 * Normalising both profiles to the same 1.15 peak pins the diagonals together
 * and lets the axes move, so blending toward this one makes the body fill out
 * across its flats — a volume change rather than a uniform scale. That is the
 * consumer of `blend`, and it is the reason breathing reads as breathing at the
 * ~170 px the Worker draws at, where a half-percent `sy` scale is invisible.
 *
 * Generated from the same equation as the body, not a second authored shape:
 * kept still ships exactly one silhouette.
 */
const INHALE_PROFILE: readonly number[] = normalize(
  superellipseProfile(MASCOT_SQUIRCLE_N - 0.5)
);

/** How much the body stretches vertically between full exhale and full inhale. */
const BREATH_SY = 0.012;

/**
 * The options both consumers pass. **This shape is frozen** — `apps/web`
 * (task 003) and `apps/edge` (task 005) both depend on it, and neither may fork
 * it.
 */
export interface MascotOptions {
  /**
   * The id of the `<mask>` the eyes clip against, referenced as `url(#maskId)`.
   *
   * **Required, with no default.** A default would be shared by every instance
   * in a document, and two mascots on one page would both clip against
   * whichever mask the parser saw last — a bug that only appears the day a
   * second render site is added, which is exactly how it would ship. `apps/web`
   * passes `useId()`; `apps/edge`, rendering one instance into a self-contained
   * document, passes a literal.
   */
  maskId: string;
  /**
   * How many points the body outline is emitted with. Defaults to the full
   * `MASCOT_SAMPLES`.
   *
   * A parameter because the Worker draws into a ~170 px box where fewer may be
   * cheaper and indistinguishable, and that measurement (task 005) must not
   * need a signature change. Must divide `MASCOT_SAMPLES` — the profile is
   * sampled at fixed angles, so taking every k-th sample is the only reduction
   * that stays angularly uniform.
   */
  samples?: number;
  /**
   * The head orientation the frame's resting life is added to. Defaults to
   * `KEPT_REST_GAZE`, which is what every caller wanted until the eyes started
   * tracking the pointer.
   *
   * Additive on purpose: `liveliness(t)`'s drift, its blink and the breath are
   * all still applied on top, so a tracking consumer supplies only where the
   * head is *aimed* and gets the same living character it had before. Pass
   * `gazeToward(nx, ny)` from `face.ts` to point it at something; pass nothing
   * (`apps/edge`, and `apps/web` under `prefers-reduced-motion`) and the frame
   * is byte-identical to the one this generator emitted before the option
   * existed.
   *
   * **Bounded by the caller, not here.** `gazeToward` clamps to
   * `KEPT_TRACK_YAW` / `KEPT_TRACK_PITCH`, the envelope that keeps both eyes
   * clear of the silhouette; an arbitrary gaze passed directly is the caller's
   * problem, exactly as an arbitrary `t` is.
   */
  gaze?: HeadGaze;
}

/** One eye of one frame: the shared capsule path plus this eye's own matrix. */
export interface MascotEye {
  d: string;
  transform: string;
}

/** The geometry of one instant — no string assembly an animated consumer must undo. */
export interface MascotFrameData {
  /** The body outline, as an SVG path `d`. */
  d: string;
  /**
   * Always two, at kept's rest gaze: the far-side cull below only fires past
   * ~90° of turn and kept's gaze plus its drift plus the split reaches 40°. An
   * animated consumer may therefore hold one ref per eye for the life of the
   * component and never reconcile the list.
   */
  eyes: MascotEye[];
}

/**
 * The pinned resting instant, in seconds.
 *
 * Every consumer depends on this one number: `apps/edge` renders it always, and
 * `apps/web` renders it under `prefers-reduced-motion` instead of starting a
 * loop. A blink frozen here would be a permanent squint on every 404.
 *
 * Chosen, not defaulted. The breath is exactly neutral only at half-multiples
 * of its 4.1 s period, so those instants were enumerated over the first two
 * minutes and ranked by how far the drift had wandered and how close the
 * nearest blink was; the shortlist was then rendered in a light and a dark
 * panel and looked at. `18.45` (= 4.5 breath cycles) won:
 *
 *   · **eyes open** — `lid === 1`, and the nearest scheduled blink is 0.98 s
 *     away in either direction, four times the 0.22 s blink itself, so no
 *     rounding of `t` downstream can land the frozen frame inside one;
 *   · **gaze near centre** — the drift here is (−0.56°, +0.90°, −0.12°), 1.07°
 *     of total excursion against an envelope of ±4.98° / ±3.22° / ±1.31°. The
 *     frozen frame is the rest gaze almost exactly, which is what makes the
 *     Worker's character and the browser's read as the same one;
 *   · **breath mid-cycle** — `breath === 0.5` exactly: neutral height, neutral
 *     profile blend, neither of the two extremes the animation visits.
 *
 * `0` was rendered and rejected on the same three tests: its breath is also
 * neutral, but its drift is 2.74° — more than twice as far off centre — and the
 * first blink lands 2.1 s later, which is well inside the interval a reader
 * spends on a 404. It is also the value that would have been picked without
 * looking, which is exactly why it is not the one.
 */
export const MASCOT_REST_T = 18.45;

/**
 * Reduce a 64-point outline to `samples` points by taking every k-th.
 *
 * Correct precisely because the profile is sampled at fixed uniform angles:
 * every k-th of 64 uniform angles is `64/k` uniform angles. Anything that does
 * not divide `MASCOT_SAMPLES` would space the points unevenly and put a visible
 * flat on one side of the body, so it fails loudly rather than quietly.
 */
function decimate(pts: readonly Point[], samples: number): readonly Point[] {
  if (samples === MASCOT_SAMPLES) return pts;
  if (!Number.isInteger(samples) || samples < 4 || MASCOT_SAMPLES % samples !== 0) {
    throw new Error(
      `mascot: samples must be an integer divisor of ${MASCOT_SAMPLES} and at least 4, got ${samples}`
    );
  }
  const step = MASCOT_SAMPLES / samples;
  const out: Point[] = [];
  for (let i = 0; i < pts.length; i += step) out.push(pts[i] as Point);
  return out;
}

/**
 * The geometry of one instant.
 *
 * Pure: the same `t` and the same options always produce the identical strings,
 * which is what makes task 005's snapshot stable and what lets the browser and
 * the Worker agree on `MASCOT_REST_T` without sharing anything but this module.
 */
export function mascotFrame(t: number, opts: MascotOptions): MascotFrameData {
  const life = liveliness(t);
  const R = MASCOT_BODY_R;

  // ── body ────────────────────────────────────────────────────────────────
  const radii = blend(BODY_PROFILE, INHALE_PROFILE, life.breath);
  const sil: Silhouette = {
    radii,
    rot: 0,
    cx: life.driftX,
    cy: life.driftY,
    sx: 1,
    sy: lerp(1 - BREATH_SY, 1 + BREATH_SY, life.breath),
  };
  const d = closedPath(decimate(toPoints(sil, R), opts.samples ?? MASCOT_SAMPLES));

  // ── eyes ────────────────────────────────────────────────────────────────
  // The eyes live on a unit sphere. The moment the silhouette stops being a
  // circle they have to be re-seated at the proportion of the REAL radius in
  // their own direction, or they escape the body and the mask crops them.
  const base = opts.gaze ?? KEPT_REST_GAZE;
  const gaze = {
    yaw: base.yaw + life.dYaw,
    pitch: base.pitch + life.dPitch,
    roll: base.roll + life.dRoll,
  };
  const eyeD = keptEyePath(R);
  const k = blinkScale(life.lid);
  const eyes: MascotEye[] = [];

  eyePoses(gaze, R, KEPT_EYE_SPLIT).forEach((e, i) => {
    // A sphere has a far side. An eye whose normal points away from the viewer
    // is behind the body and must not be drawn — without this the model is two
    // ellipses stuck on a disc rather than a face on a ball, and `depth` has no
    // consumer at all.
    if (e.depth <= 0) return;

    const fit = radiusAtAngle(radii, Math.atan2(e.y, e.x)) * KEPT_EYE_INSET;

    // The eye's own tilt is composed with the tangent basis (basis × rotation),
    // mirrored between the two eyes so the tops splay outward — a head roll
    // alone tips both the same way and cannot do that.
    const phi = ((i === 0 ? KEPT_EYE_TILT : -KEPT_EYE_TILT) * Math.PI) / 180;
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    const ax = e.a * cp + e.c * sp;
    const ay = e.b * cp + e.d * sp;
    const cx = -e.a * sp + e.c * cp;
    const cy = -e.b * sp + e.d * cp;

    // The blink applies AFTER all of that: it is a vertical squash on screen,
    // not a shrink along the capsule's tilted axis, so it only touches y.
    eyes.push({
      d: eyeD,
      transform:
        `matrix(${r2(ax)},${r2(ay * k)},${r2(cx)},${r2(cy * k)},` +
        `${r2(e.x * fit + life.driftX * R)},${r2(e.y * fit + life.driftY * R)})`,
    });
  });

  return { d, eyes };
}

/**
 * One instant as a complete, self-contained inline `<svg>`.
 *
 * No `<script>`, no `src=`, no `srcset`, no `@import`, no `data:` URI, and the
 * only `url()` is the same-document `#fragment` that points at the mask defined
 * two lines above it. That is the contract `apps/edge`'s `expectSelfContained`
 * already encodes; this markup is written to satisfy it unmodified.
 *
 * The body is drawn twice — once filled, once into the mask — so the eyes clip
 * to the silhouette instead of hanging off it.
 */
export function mascotSvg(t: number, opts: MascotOptions): string {
  const { d, eyes } = mascotFrame(t, opts);
  const id = opts.maskId;
  const eyeMarkup = eyes
    .map((e) => `<path d="${e.d}" transform="${e.transform}"/>`)
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MASCOT_VIEWBOX}" ` +
    `aria-hidden="true" focusable="false">` +
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="${-VIEW_HALF}" y="${-VIEW_HALF}" ` +
    `width="${VIEW_HALF * 2}" height="${VIEW_HALF * 2}">` +
    `<path d="${d}" fill="white"/>` +
    `</mask>` +
    `<path d="${d}" fill="currentColor"/>` +
    `<g mask="url(#${id})" fill="var(--bg)">${eyeMarkup}</g>` +
    `</svg>`
  );
}
