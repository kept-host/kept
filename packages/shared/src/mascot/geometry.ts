// kept mascot — geometry primitives.
//
// ─── Attribution ────────────────────────────────────────────────────────────
// Derived from **bloub** — https://github.com/jeremy-prt/bloub
// Copyright © 2026 Jérémy Perret. Released under the MIT licence.
// Full licence text: `THIRD-PARTY.md` at the repository root.
//
// Read at commit b4bb3c1b5f93c7b87a2e8d620f667c4093d97749 (2026-08-17),
// files `src/bot/shape.ts`, `src/bot/math.ts`, `src/bot/skins.ts`.
//
// TAKEN — generic engineering, no brand identity in it:
//   · the fixed-sample radial-profile representation itself (every profile is
//     sampled at the SAME angles, so morphing is a per-index lerp and needs no
//     path-morph library);
//   · `superellipseProfile`, `normalize`, `blend`, `toPoints`, `closedPath`
//     (Catmull-Rom, tension 1/6), `radiusAtAngle`;
//   · the `lerp` and `r2` helpers those depend on.
//
// NOT TAKEN — **no measured profile and no measured face constant was copied.**
// bloub describes itself as an SVG recreation of the x.ai bot avatar, measured
// off the reference video frame by frame. Its `profiles.ts` shape library and
// its eye split, eye dimensions and rest gaze are that measurement, and a
// mascot's whole job is to be recognised as belonging to a specific company.
// The technique crosses over; the character does not. kept ships one shape,
// generated below from an equation, and picks its own face constants (see
// `face.ts`).
//
// Deviations from the source, deliberate: the pooled `out` buffers bloub uses
// to avoid allocating at 60 fps are dropped (one decorative mascot, 64 points a
// frame — the shared mutable buffer is a worse trade than the garbage), and the
// shape library, the pose editor and the build-time eye-fit solver are absent
// because kept has one shape and one expression, so they would be dead code.
// ────────────────────────────────────────────────────────────────────────────
//
// Pure and platform-free by contract: no browser global, no DOM API, no Node
// built-in, anywhere under `src/mascot/`. That constraint is what lets the
// Cloudflare Worker in `apps/edge` call this module at all, so it is asserted
// by a test rather than trusted to review; the exact banned list lives there.

/** A point in viewBox space. */
export interface Point {
  x: number;
  y: number;
}

/**
 * A silhouette = a radial profile `r(theta)` plus a pose.
 *
 * `radii` is always `MASCOT_SAMPLES` long and sampled at `SAMPLE_ANGLES`, which
 * is what makes `blend` a plain per-index lerp.
 */
export interface Silhouette {
  /** Radial profile, `MASCOT_SAMPLES` samples, in body-radius units. */
  radii: readonly number[];
  /** Profile rotation, radians. */
  rot: number;
  /** Centre offset, in body-radius units. */
  cx: number;
  cy: number;
  /** Squash & stretch, applied in screen space (after rotation). */
  sx: number;
  sy: number;
}

export const TAU = Math.PI * 2;

/**
 * How many angles every profile is sampled at.
 *
 * Exported and referenced everywhere rather than written as a literal: the
 * Worker's frozen frame renders into a ~170 px box where a lower count may be
 * cheaper, and that measurement needs exactly one place to change.
 *
 * 64 is smooth to the pixel at 600 px once Catmull-Rom is applied.
 */
export const MASCOT_SAMPLES = 64;

/** The squircle exponent kept's body is drawn with. `n = 2` is an ellipse. */
export const MASCOT_SQUIRCLE_N = 4.2;

/**
 * The sample angles, computed once and shared by every profile.
 *
 * `theta = 0` points right and increases clockwise on screen (y points down).
 */
export const SAMPLE_ANGLES: readonly number[] = Array.from(
  { length: MASCOT_SAMPLES },
  (_, i) => (i / MASCOT_SAMPLES) * TAU
);

const COS: readonly number[] = SAMPLE_ANGLES.map(Math.cos);
const SIN: readonly number[] = SAMPLE_ANGLES.map(Math.sin);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Short rounding. Halves the weight of the emitted path strings, which matters
 * once for the Worker's inline SVG and sixty times a second in the browser.
 */
export const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Superellipse profile: `|x/sx|ⁿ + |y/sy|ⁿ = 1`, sampled in polar form at the
 * shared angles.
 */
export function superellipseProfile(n: number, sx = 1, sy = 1): number[] {
  const out = new Array<number>(MASCOT_SAMPLES);
  for (let i = 0; i < MASCOT_SAMPLES; i++) {
    const c = Math.abs((COS[i] ?? 0) / sx) ** n;
    const s = Math.abs((SIN[i] ?? 0) / sy) ** n;
    out[i] = (c + s) ** (-1 / n);
  }
  return out;
}

/**
 * Rescale a profile so its largest radius is `max`.
 *
 * **`max` defaults to 1.15, not 1.0, and that is load-bearing.** A
 * superellipse's maximum radius is its *diagonal*, so normalising it to the
 * radius of a unit circle produces a body that reads visibly smaller than one —
 * and, worse, seats anything placed by `radiusAtAngle` on a contour that is not
 * the drawn silhouette, so the eyes clip through the edge.
 */
export function normalize(radii: readonly number[], max = 1.15): number[] {
  const peak = Math.max(...radii);
  if (peak <= 0) return [...radii];
  const k = max / peak;
  return radii.map((r) => r * k);
}

/**
 * kept's body: one squircle, normalised. Computed once at module load — 64
 * samples, which is why this module sits behind the `@kept/shared/mascot`
 * subpath and not in the barrel.
 */
export const BODY_PROFILE: readonly number[] = normalize(
  superellipseProfile(MASCOT_SQUIRCLE_N)
);

/**
 * Per-index lerp between two profiles.
 *
 * This is a three-line function *only* because every profile shares the same
 * `SAMPLE_ANGLES`, so sample `i` of one shape always corresponds to sample `i`
 * of another. That single decision is why the whole generator is a few hundred
 * lines and needs no path-morphing library. Do not "generalise" it to profiles
 * of differing sample counts — that trades the entire saving for a feature kept
 * has no use for.
 */
export function blend(
  a: readonly number[],
  b: readonly number[],
  t: number
): number[] {
  const out = new Array<number>(MASCOT_SAMPLES);
  for (let i = 0; i < MASCOT_SAMPLES; i++) {
    out[i] = lerp(a[i] ?? 1, b[i] ?? 1, t);
  }
  return out;
}

/**
 * Project a silhouette into viewBox points.
 *
 * `scale` is the body radius in viewBox units.
 */
export function toPoints(s: Silhouette, scale: number): Point[] {
  const cr = Math.cos(s.rot);
  const sr = Math.sin(s.rot);
  const out = new Array<Point>(MASCOT_SAMPLES);
  for (let i = 0; i < MASCOT_SAMPLES; i++) {
    const r = s.radii[i] ?? 1;
    const x = r * (COS[i] ?? 0);
    const y = r * (SIN[i] ?? 0);
    // rotate, then squash in screen space, then translate
    const rx = x * cr - y * sr;
    const ry = x * sr + y * cr;
    out[i] = {
      x: (rx * s.sx + s.cx) * scale,
      y: (ry * s.sy + s.cy) * scale,
    };
  }
  return out;
}

/**
 * Closed polyline → cubic Catmull-Rom, emitted as an SVG `d` string.
 *
 * Centred tangents are plenty at 64 points: the contour is smooth to the pixel
 * even at 600 px, and the string stays short.
 */
export function closedPath(pts: readonly Point[], tension = 1 / 6): string {
  const n = pts.length;
  if (n < 3) return "";
  const first = pts[0] as Point;
  let d = `M${r2(first.x)} ${r2(first.y)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n] as Point;
    const p1 = pts[i] as Point;
    const p2 = pts[(i + 1) % n] as Point;
    const p3 = pts[(i + 2) % n] as Point;
    const c1x = p1.x + (p2.x - p0.x) * tension;
    const c1y = p1.y + (p2.y - p0.y) * tension;
    const c2x = p2.x - (p3.x - p1.x) * tension;
    const c2y = p2.y - (p3.y - p1.y) * tension;
    d += `C${r2(c1x)} ${r2(c1y)} ${r2(c2x)} ${r2(c2y)} ${r2(p2.x)} ${r2(p2.y)}`;
  }
  return `${d}Z`;
}

/**
 * The contour radius at an arbitrary angle, interpolated between the two
 * neighbouring samples.
 *
 * This is what sits the eyes *on* a non-circular silhouette. Without it, an eye
 * placed at 0.62 of the body radius escapes a shape whose edge is at 0.55 in
 * that direction and the mask crops it. On a squircle that is a real defect,
 * not a theoretical one.
 */
export function radiusAtAngle(radii: readonly number[], angle: number): number {
  const n = radii.length;
  const t = ((((angle / TAU) % 1) + 1) % 1) * n;
  const i = Math.floor(t);
  return lerp(radii[i % n] ?? 1, radii[(i + 1) % n] ?? 1, t - i);
}
