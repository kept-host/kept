// kept mascot — the face: the eye model, the resting expression, and the
// clockwork that keeps the character alive without any state at all.
//
// ─── Attribution ────────────────────────────────────────────────────────────
// Derived from **bloub** — https://github.com/jeremy-prt/bloub
// Copyright © 2026 Jérémy Perret. Released under the MIT licence.
// Full licence text: `THIRD-PARTY.md` at the repository root.
//
// Read at commit b4bb3c1b5f93c7b87a2e8d620f667c4093d97749 (2026-08-17),
// files `src/bot/face.ts` and `src/bot/math.ts`.
//
// TAKEN — generic engineering, no brand identity in it:
//   · the idea that the eyes are painted on a sphere rather than laid flat, and
//     the head frame that follows from it — a forward/right/down basis spun by
//     yaw, then pitch, then roll, from which each eye gets an orthographic
//     position, a 2×2 tangent basis and a depth. Foreshortening and tilt then
//     fall out of the projection instead of being authored;
//   · `liveliness(t)` as a PURE FUNCTION OF TIME — periodic drift plus a
//     pre-drawn blink calendar, so pausing, resuming or jumping to an arbitrary
//     instant always yields the same image. That property is the whole reason
//     `apps/edge` can freeze one frame and `apps/web` can animate the same
//     function and get the same character;
//   · the shape of the blink: a fast close and a slower re-open, applied as a
//     VERTICAL squash in screen space after the tangent basis, not as a
//     shrink along the eye's own tilted axis;
//   · `loopNoise` (three harmonics, seamless over its period) and the
//     mulberry32 `createRng` used to draw the calendar.
//
// NOT TAKEN — **no measured face constant was copied.** bloub's eye split, eye
// width, eye height and rest gaze are fitted to the x.ai bot avatar, measured
// off its reference video frame by frame; that is precisely the part whose job
// is to be recognised as belonging to a specific company. Every constant in the
// "kept's own face" block below was chosen by rendering this generator into a
// light and a dark panel and looking at the result, and each one records what
// was looked at. None is a bloub value, and none is a bloub value scaled.
// bloub's per-expression editor, its 17-state machine and its build-time
// eye-fit solver are absent too: kept has one shape and one expression, so all
// three would be dead code (see `KEPT_EYE_INSET`, which replaces the solver).
// ────────────────────────────────────────────────────────────────────────────
//
// Pure and platform-free by contract: no browser global, no DOM API, no Node
// built-in. Asserted by `apps/web/lib/mascot/generator-contract.test.ts`.

import { TAU, r2 } from "./geometry";

/** A direction in the head's own 3-space. Screen axes: x right, y down, z toward the viewer. */
type Vec3 = [number, number, number];

const clamp = (v: number, lo = 0, hi = 1): number => (v < lo ? lo : v > hi ? hi : v);

const deg = (d: number): number => (d * Math.PI) / 180;

/**
 * Seamless 1-D noise: three harmonics that close exactly on `period`.
 *
 * Used for gaze drift. Because it is built from sines of `t`, it is a pure
 * function of time with no accumulator to desynchronise between the browser's
 * animated copy and the Worker's frozen one.
 */
function loopNoise(t: number, period: number, seed = 0): number {
  const p = (t / period) * TAU;
  return (
    0.55 * Math.sin(p + seed) +
    0.3 * Math.sin(2 * p + seed * 1.7 + 1.1) +
    0.15 * Math.sin(3 * p + seed * 2.3 + 2.4)
  );
}

/** Deterministic PRNG (mulberry32): the same sequence on every module load, in every runtime. */
function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where the head is pointing. Degrees. */
export interface HeadGaze {
  /** Yaw: positive looks to the viewer's right. */
  yaw: number;
  /** Pitch: positive looks up. */
  pitch: number;
  /** Roll: the head tips within its own plane; positive tips the crown to the right. */
  roll: number;
}

/** One eye, projected. `a b c d` are an SVG `matrix(a,b,c,d,e,f)` tangent basis. */
export interface EyePose {
  x: number;
  y: number;
  a: number;
  b: number;
  c: number;
  d: number;
  /** z of the eye's outward normal. Greater than zero means the eye faces the viewer. */
  depth: number;
}

/** Rotate two vectors of an orthonormal frame within the plane they span. */
function spin(u: Vec3, v: Vec3, angle: number): [Vec3, Vec3] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s],
    [v[0] * c - u[0] * s, v[1] * c - u[1] * s, v[2] * c - u[2] * s],
  ];
}

// ─── kept's own face ─────────────────────────────────────────────────────────
//
// The five constants below are the only values in this epic that cannot be
// derived — not from the source (bloub's are measured off somebody else's
// avatar) and not from arithmetic. Each was picked by emitting `mascotSvg(t)`
// at a spread of `t` into one HTML page with a light panel and a dark panel
// side by side, and looking. The comments record what was looked at, because a
// number without that record is indistinguishable from a default.

/**
 * Half the angular gap between the eyes on the unit sphere, in degrees — so the
 * eyes are `2 × 24 = 48°` apart.
 *
 * Rendered at 14°, 17°, 21°, 24° and 28°, in both themes, at 300 px and at the
 * ~170 px the Worker's system pages draw the character at — 170 px is the size
 * that has to survive, so it decided this. At 14° the two capsules merge into
 * one smudge there and the face reads cross-eyed. 28° pushes the outer eye onto
 * the squircle's flank and the head stops reading as facing you. 21° was the
 * first value that worked; 24° was better in the side-by-side, because the
 * wider pair reads open and childlike rather than appraising — kept is a thing
 * you hand a file to.
 *
 * Nowhere near bloub's measured half-split: wider, and chosen against a
 * small-render legibility constraint that bloub does not have.
 */
export const KEPT_EYE_SPLIT = 24;

/**
 * Eye width, in body-radius units.
 *
 * kept ships exactly one expression, so this pair IS kept's neutral: expressed
 * against it the resting expression is 1.0× wide and 1.0× tall, inside the
 * documented 0.8–2.7× / 0.3–1.5× envelope an expression system would move
 * within.
 *
 * Rendered at 0.16, 0.20, 0.22, 0.26 and 0.27. 0.16 is a slit and vanishes at
 * 170 px. Below about 0.22 the character reads blank — the first sheet used
 * 0.22 and the blob looked like it was asleep with its eyes open. 0.27 is the
 * widest that still leaves a clear gap between the pair at the chosen split.
 */
export const KEPT_EYE_W = 0.27;

/**
 * Eye height, in body-radius units. Aspect ratio 31∶27 ≈ 1.15∶1.
 *
 * The ratio is the expression, so it was tuned last and looked at hardest.
 * Rendered at 0.26 (round — blank and doll-like), 0.30, 0.31, 0.33 and 0.46
 * (≈1.7∶1 at this width — a tall slit, which reads cool and appraising, the
 * opposite of what kept wants). 0.31 keeps a visible straight section in the
 * capsule, so it is an eye and not a dot, while staying barely taller than
 * wide. Attentive, not severe.
 */
export const KEPT_EYE_H = 0.31;

/**
 * Each eye's own tilt within the eye plane, in degrees, applied MIRRORED — the
 * inner eye gets `+`, the outer `−`, so the tops splay outward.
 *
 * Well inside the ±80° the model tolerates; deliberately tiny. Rendered at 0
 * (correct and inert — two ovals stuck on a ball), 5, 6, 9 and 16 (a pantomime
 * eyebrow that at 170 px reads as a rendering fault). 6° is the smallest value
 * still legible at the Worker's size, and it is what turns the pair from
 * decoration into a face. Not derivable: the whole question is where "alive"
 * turns into "mugging".
 */
export const KEPT_EYE_TILT = 6;

/**
 * kept's resting head orientation.
 *
 * A near-front-on attend, not a three-quarter pose: the character's job on
 * `/auth` and on a 404 is to be looking at the person reading the page.
 *
 * Rendered across a grid, in both themes. `yaw: -11` is a small turn to the
 * viewer's left — enough that the sphere model's foreshortening is visible on
 * the far eye and the head has volume, small enough that both eyes stay clear
 * of the silhouette's flanks under the whole gaze drift (measured envelope:
 * yaw ±4.98°, pitch ±3.22°, roll ±1.31°). At yaw 0 the model's entire point is
 * invisible and the face is flat card; at −20° with the drift on top the outer
 * eye reaches the squircle's shoulder and the mask starts to bite.
 *
 * `pitch: 13` lifts the pair off the body's equator — at pitch 0 the eyes sit
 * dead centre and the blob reads bottom-heavy and sad. 13° places them about a
 * fifth of the body radius above centre, the high-forehead proportion that
 * reads young and alert. Past ~20° they climb onto the crown and the character
 * reads as looking past you.
 *
 * `roll: 7` is the head-cock, and it is the value that does the most per
 * degree: 0 is inert, 7 is a listening tilt, 12 is quizzical to the point of
 * comic. Tipped the same way the yaw turns, so the two read as one gesture.
 *
 * All three are kept's own; none is bloub's measured rest gaze, and the roll is
 * deliberately tipped the opposite way to it.
 */
export const KEPT_REST_GAZE: HeadGaze = { yaw: -11, pitch: 13, roll: 7 };

/**
 * How deep the eyes are seated in the head, as a fraction of the local contour
 * radius. **The one hand-tuned constant that replaces bloub's `eyefit.ts`.**
 *
 * `radiusAtAngle` re-seats an eye's CENTRE onto the real contour by scaling its
 * unit-sphere direction by the local body radius. On kept's squircle that
 * radius runs from 0.9591 on the axes to 1.1500 on the diagonals (the 1.15 that
 * `normalize` exists to preserve), so an eye lying near a diagonal is pushed
 * 15% further out than the direction alone asks for — and the clearance in
 * front of it is scaled by the same factor, so it is pushed hardest exactly
 * where the silhouette has least room to give. bloub calls the resulting notch
 * a shipped bug, not a theoretical one, and solves it with a build-time solver
 * returning one nudge per (shape, state, expression) triple. kept has one shape
 * and one expression, so that solver would emit exactly one number and be dead
 * code around it. This is that number.
 *
 * Rendered at 1.15, 1.0, 0.93, 0.9 and 0.84 at the pinned rest instant, mask on
 * and mask off side by side. **At 1.15 the defect reproduces**: the outer eye
 * crosses the silhouette and the mask crops it to a crescent stuck on the rim.
 * At 1.0 — the seat sitting exactly on the contour, i.e. no correction at all —
 * the eye survives but with a hairline of body outside it, which the gaze drift
 * then eats into. 0.93 clears the drift. 0.9 keeps roughly a third of an
 * eye-width of body outside the eye everywhere, at every `t` sampled, and reads
 * as a face set INTO the head rather than stuck onto it. 0.84 pulls the pair
 * together until it reads cross-eyed. 0.9.
 *
 * A scalar rather than an `{x, y}` nudge: the error is radial, so scaling the
 * seat stays correct under every gaze instead of being right for one pose.
 */
export const KEPT_EYE_INSET = 0.9;

/**
 * One eye, as a capsule centred on the origin, at a body radius of `scale`.
 *
 * Both eyes are the same shape — only their matrices differ — so a frame draws
 * this once. Emitted as a path rather than an `<ellipse>` so the eye keeps its
 * straight section, which is what stops `KEPT_EYE_H` from reading as a dot.
 */
export function keptEyePath(scale: number): string {
  const hw = (KEPT_EYE_W * scale) / 2;
  const hh = (KEPT_EYE_H * scale) / 2;
  const r = Math.min(hw, hh);
  return (
    `M${r2(-hw)} ${r2(-hh + r)}` +
    `A${r2(r)} ${r2(r)} 0 0 1 ${r2(-hw + r)} ${r2(-hh)}` +
    `L${r2(hw - r)} ${r2(-hh)}` +
    `A${r2(r)} ${r2(r)} 0 0 1 ${r2(hw)} ${r2(-hh + r)}` +
    `L${r2(hw)} ${r2(hh - r)}` +
    `A${r2(r)} ${r2(r)} 0 0 1 ${r2(hw - r)} ${r2(hh)}` +
    `L${r2(-hw + r)} ${r2(hh)}` +
    `A${r2(r)} ${r2(r)} 0 0 1 ${r2(-hw)} ${r2(hh - r)}Z`
  );
}

// ─── the eye model ───────────────────────────────────────────────────────────

/**
 * The head frame, then each eye's frame.
 *
 * Index 0 is the eye nearer the head's own centre line as seen from the front,
 * index 1 the farther one. Each pose carries an orthographic position on a
 * sphere of radius `scale`, a 2×2 tangent basis for the eye's own plane, and
 * the z of its normal.
 */
export function eyePoses(
  gaze: HeadGaze,
  scale: number,
  split = KEPT_EYE_SPLIT
): [EyePose, EyePose] {
  let f: Vec3 = [0, 0, 1];
  let right: Vec3 = [1, 0, 0];
  let down: Vec3 = [0, 1, 0];

  // yaw: forward tips toward right
  [f, right] = spin(f, right, deg(gaze.yaw));
  // pitch: forward tips away from down, i.e. upward on screen
  [down, f] = spin(down, f, deg(gaze.pitch));
  // roll: the head leans within its own plane
  [right, down] = spin(right, down, deg(gaze.roll));

  const build = (side: number): EyePose => {
    const [ef, er] = spin(f, right, deg(split * side));
    return {
      x: ef[0] * scale,
      y: ef[1] * scale,
      a: er[0],
      b: er[1],
      c: down[0],
      d: down[1],
      depth: ef[2],
    };
  };

  return [build(-1), build(1)];
}

/**
 * The eyelid curve: how much of the eye's screen height survives at lid `lid`.
 *
 * Never reaches zero — a closed eye is a line of body colour with a sliver
 * still showing, which reads as a lid rather than as the eye having been
 * deleted for two frames.
 */
export function blinkScale(lid: number): number {
  return 0.06 + 0.94 * clamp(lid);
}

/**
 * Resting life: everything that moves when nothing is happening.
 *
 * A pure function of `t` (seconds). No accumulator, no internal state: the same
 * `t` gives the same values forever, in any runtime. That is what lets
 * `apps/edge` freeze `MASCOT_REST_T` and `apps/web` animate the identical
 * function without the two characters drifting apart.
 */
export interface Liveliness {
  /** Degrees to add to the rest gaze. */
  dYaw: number;
  dPitch: number;
  dRoll: number;
  /** 1 = eye fully open, 0 = shut. */
  lid: number;
  /** Body drift, in body-radius units. */
  driftX: number;
  driftY: number;
  /** Breath phase in [0, 1]: 0 fully exhaled, 1 fully inhaled. */
  breath: number;
}

/** Blink calendar bounds. 20 minutes of schedule; the loop wraps past it. */
const BLINK_SPAN_S = 1200;
/** First blink. Late enough that a freshly mounted mascot is not caught mid-blink. */
const BLINK_FIRST_S = 2.1;
/** How long one blink takes, close and re-open. */
const BLINK_DUR = 0.22;

/**
 * The pre-drawn blink calendar — roughly 470 instants, LAZILY built.
 *
 * Lazy, not module-level, and behind the `@kept/shared/mascot` subpath as well:
 * ~470 entries cost nothing in a browser and are a measurable slice of a Worker
 * cold start, and the Worker renders exactly one frame. The subpath is the
 * structural guard, this is the belt to it.
 *
 * **Do not shrink the table.** Its irregularity is the entire point: a blink on
 * a fixed period is a metronome and reads as a fault. The gaps run 1.7–4.2 s
 * with an occasional double blink, and the sequence never repeats inside the
 * window.
 */
let blinkCalendar: readonly number[] | null = null;

function blinks(): readonly number[] {
  if (blinkCalendar) return blinkCalendar;
  const rng = createRng(0x6b657074); // "kept"
  const out: number[] = [];
  let t = BLINK_FIRST_S;
  while (t < BLINK_SPAN_S) {
    out.push(t);
    t += 1.7 + rng() * 2.5;
    if (rng() < 0.17) {
      // a double blink, close behind the first
      out.push(t);
      t += 0.27;
    }
  }
  blinkCalendar = out;
  return out;
}

function blinkLid(t: number): number {
  const wrapped = ((t % BLINK_SPAN_S) + BLINK_SPAN_S) % BLINK_SPAN_S;
  const table = blinks();
  for (let i = 0; i < table.length; i++) {
    const start = table[i] as number;
    if (wrapped < start) break;
    const k = (wrapped - start) / BLINK_DUR;
    if (k >= 0 && k <= 1) {
      // shut fast, open slower — the asymmetry is what makes it read as a blink
      return k < 0.42 ? 1 - k / 0.42 : (k - 0.42) / 0.58;
    }
  }
  return 1;
}

/**
 * Periods are mutually incommensurate on purpose, so the drift never visibly
 * repeats. Amplitudes are kept's own and deliberately calm: the character is
 * attending to you, not scanning the room.
 */
export function liveliness(t: number): Liveliness {
  return {
    dYaw: loopNoise(t, 12.7, 0.4) * 4 + loopNoise(t, 5.3, 2.1) * 1.2,
    dPitch: loopNoise(t, 10.1, 1.3) * 3 + loopNoise(t, 6.7, 0.7) * 0.9,
    dRoll: loopNoise(t, 17.9, 3.2) * 1.6,
    lid: blinkLid(t),
    driftX: loopNoise(t, 8.9, 1.9) * 0.006,
    driftY: loopNoise(t, 5.9, 0.3) * 0.007,
    breath: 0.5 + 0.5 * Math.sin((t / 4.1) * TAU),
  };
}
