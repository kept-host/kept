/**
 * Under `prefers-reduced-motion: reduce` the mascot must start **no**
 * `requestAnimationFrame` loop — not a loop that ticks and discards its output —
 * and must register **no** pointer listener, not a listener whose gaze is then
 * ignored.
 *
 * ── WHY THIS IS ASSERTED AND NOT REVIEWED ──────────────────────────────────
 * A loop that runs and throws its frames away is indistinguishable from a
 * correct implementation in a screenshot, in a diff review, and in every
 * accessibility check that only looks at whether the pixels moved. It is also
 * exactly the shape a careless implementation lands on, because "compute the
 * frame, then decide whether to draw it" reads as the tidier branch. The only
 * thing that separates the two is a count of scheduler calls.
 *
 * ── WHY HERE AND NOT IN PLAYWRIGHT ─────────────────────────────────────────
 * `apps/web`'s unit suite is `tsx --test` on Node: no DOM, so nothing here can
 * render `<Mascot />`. The browser alternative — `page.emulateMedia({
 * reducedMotion: "reduce" })` plus a counter installed over
 * `window.requestAnimationFrame` via `addInitScript` — needs a route that
 * mounts the component. `/auth` mounts it as of task 004, so that spec became
 * possible only after this file was written; task 008 owns whether to add it.
 *
 * So the branch is factored instead: `startMascotLoop` is the decision, it
 * takes its scheduler as an argument, and this file counts the calls. That is
 * not a stand-in for the component's behaviour — it *is* the component's
 * behaviour, because the effect in `mascot.tsx` does nothing but hand this
 * function the real `matchMedia` result and the real `window` scheduler.
 *
 * Nothing here needs credentials, a network or a browser.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type HeadGaze,
  KEPT_REST_GAZE,
  KEPT_TRACK_YAW,
  MASCOT_REST_T,
} from "@kept/shared/mascot";

import { startMascotLoop } from "../../components/kept/mascot";

/**
 * A scheduler that records instead of scheduling. Not a mock of a service —
 * `requestAnimationFrame` is the one thing this function is being asked a
 * question about, and the question is "how many times did you call it".
 */
function recordingScheduler() {
  let nextHandle = 0;
  let pending: ((now: number) => void) | null = null;
  let aim: ((nx: number, ny: number) => void) | null = null;
  const record = {
    rafCalls: 0,
    cancelled: [] as number[],
    painted: [] as number[],
    gazes: [] as HeadGaze[],
    /**
     * How many times the loop asked to be subscribed to the pointer. This is
     * the whole reason `track` is a parameter: in the component that call is
     * three `window.addEventListener`s, so "did the loop subscribe" and "does
     * the page have pointer/resize/scroll listeners on it" are the same fact.
     */
    trackCalls: 0,
    untrackCalls: 0,
    raf(cb: (now: number) => void): number {
      record.rafCalls += 1;
      pending = cb;
      nextHandle += 1;
      return nextHandle;
    },
    caf(handle: number): void {
      record.cancelled.push(handle);
    },
    paint(t: number, gaze: HeadGaze): void {
      record.painted.push(t);
      record.gazes.push(gaze);
    },
    track(onAim: (nx: number, ny: number) => void): () => void {
      record.trackCalls += 1;
      aim = onAim;
      return () => {
        record.untrackCalls += 1;
        aim = null;
      };
    },
    /** Move the "pointer" to a normalised offset from the mascot's centre. */
    point(nx: number, ny: number): void {
      assert.ok(aim, "expected the loop to have subscribed to the pointer");
      aim(nx, ny);
    },
    /** Run the frame the loop most recently scheduled, at `now` milliseconds. */
    advance(now: number): void {
      const cb = pending;
      assert.ok(cb, "expected a scheduled frame to run");
      pending = null;
      cb(now);
    },
  };
  return record;
}

test("reduced motion paints the resting frame, starts no rAF loop, and registers no pointer listener", () => {
  const s = recordingScheduler();

  const stop = startMascotLoop(true, s.paint, s.raf, s.caf, s.track);

  assert.deepEqual(
    s.painted,
    [MASCOT_REST_T],
    "under reduce the mascot must paint MASCOT_REST_T exactly once — the same instant apps/edge " +
      "freezes into its system pages — and then hold it.",
  );
  assert.deepEqual(
    s.gazes,
    [KEPT_REST_GAZE],
    "and it must paint it at the REST gaze. Passing KEPT_REST_GAZE explicitly is byte-identical " +
      "to passing no gaze at all (frame.ts falls back to exactly this), so the frozen character " +
      "is unchanged by the tracking existing.",
  );
  assert.equal(
    s.rafCalls,
    0,
    "under prefers-reduced-motion: reduce the component must call requestAnimationFrame ZERO " +
      "times. A loop that ticks and discards its frames is a CPU cost with no visible effect.",
  );
  assert.equal(
    s.trackCalls,
    0,
    "and it must not subscribe to the pointer AT ALL — not subscribe-then-ignore. In the " +
      "component this call is the pointermove/resize/scroll addEventListener trio, so a single " +
      "call here is three listeners on a page that asked for no motion.",
  );

  stop();

  assert.equal(s.rafCalls, 0, "cleanup must not start anything either");
  assert.equal(s.trackCalls, 0, "nor subscribe on the way out");
  assert.deepEqual(
    s.cancelled,
    [],
    "there is nothing to cancel: the reduced branch started nothing. Cleanup is still safe to " +
      "call, which is what makes the effect's contract uniform across both branches.",
  );
});

test("with motion allowed the loop runs, advances t from the rAF clock, and cancels on cleanup", () => {
  const s = recordingScheduler();

  const stop = startMascotLoop(false, s.paint, s.raf, s.caf, s.track);

  assert.deepEqual(
    s.painted,
    [MASCOT_REST_T],
    "the animated timeline starts at the resting frame, so both audiences see the same pose on " +
      "arrival and only one of them then breathes.",
  );
  assert.equal(s.rafCalls, 1, "exactly one frame is scheduled up front");
  assert.equal(s.trackCalls, 1, "the pointer is subscribed exactly once, not once per frame");

  // The first callback's timestamp is the origin, so t must not have moved yet.
  s.advance(1_000);
  assert.deepEqual(s.painted, [MASCOT_REST_T, MASCOT_REST_T]);
  assert.equal(s.rafCalls, 2, "each frame schedules the next");

  s.advance(1_500);
  assert.equal(
    s.painted[2],
    MASCOT_REST_T + 0.5,
    "t advances in SECONDS from the rAF timestamp, not from module evaluation or hydration time",
  );
  assert.equal(s.rafCalls, 3);

  stop();

  assert.deepEqual(
    s.cancelled,
    [3],
    "cleanup must cancel the frame that is actually outstanding — the most recently scheduled " +
      "handle, not the first one. NO RESOURCE LEAKS.",
  );
  assert.equal(s.rafCalls, 3, "and it must not schedule anything on the way out");
  assert.equal(
    s.untrackCalls,
    1,
    "and it must unsubscribe the pointer. The listeners outlive the component otherwise, and " +
      "they close over refs to a torn-down subtree. NO RESOURCE LEAKS.",
  );
});

test("the gaze eases toward the pointer instead of snapping, and rests where it started", () => {
  const s = recordingScheduler();

  const stop = startMascotLoop(false, s.paint, s.raf, s.caf, s.track);
  s.advance(0);
  assert.deepEqual(
    s.gazes[1],
    KEPT_REST_GAZE,
    "the origin frame has dt = 0, so nothing has eased yet",
  );

  // Pointer saturated to the right: the target is the far end of the envelope.
  s.point(2, 0);
  const targetYaw = KEPT_REST_GAZE.yaw + KEPT_TRACK_YAW;

  s.advance(16);
  const first = s.gazes[2];
  assert.ok(first, "expected a frame after the pointer moved");
  assert.ok(
    first.yaw > KEPT_REST_GAZE.yaw,
    "one frame after the pointer moves the eyes must have started travelling",
  );
  assert.ok(
    first.yaw < KEPT_REST_GAZE.yaw + KEPT_TRACK_YAW * 0.25,
    `a single 16ms frame must cover only a small fraction of the way (got ${first.yaw}). ` +
      "Snapping to the target in one frame is the failure this test exists for.",
  );

  // A second and a half of frames, and it is essentially there.
  for (let ms = 32; ms <= 1_500; ms += 16) s.advance(ms);
  const settled = s.gazes[s.gazes.length - 1];
  assert.ok(settled, "expected settled frames");
  assert.ok(
    Math.abs(settled.yaw - targetYaw) < 0.05,
    `after ~1.5s of frames the gaze must have arrived (got ${settled.yaw}, want ${targetYaw})`,
  );
  assert.equal(
    settled.roll,
    KEPT_REST_GAZE.roll,
    "roll is a fixed characteristic of the face — tracking must never cock the head",
  );

  // Frame-rate independence: the same wall-clock elapsed at half the frame rate
  // must land in the same place, or the ease is a per-frame lerp in disguise.
  const slow = recordingScheduler();
  const stopSlow = startMascotLoop(false, slow.paint, slow.raf, slow.caf, slow.track);
  slow.advance(0);
  slow.point(2, 0);
  for (let ms = 32; ms <= 1_500; ms += 32) slow.advance(ms);
  const slowSettled = slow.gazes[slow.gazes.length - 1];
  assert.ok(slowSettled, "expected settled frames at 30fps");
  assert.ok(
    Math.abs(slowSettled.yaw - settled.yaw) < 0.05,
    `30fps and 60fps must reach the same gaze after the same elapsed time (got ` +
      `${slowSettled.yaw} vs ${settled.yaw}). A fixed per-frame lerp eases twice as fast on the ` +
      "faster display, which is exactly the machine most likely to be watching.",
  );

  stopSlow();
  stop();
});

/**
 * The shadow is the other half of "reduce stops the movement, not the drawing",
 * and it is the half a scheduler count cannot reach: it is CSS, so the only
 * place its shape and its gating exist is the stylesheet's source text.
 *
 * Two claims, both regressions that have actually happened or nearly did:
 *
 * 1. It must be `filter: drop-shadow()`, never a `box-shadow` and never a
 *    `shadow-*` Tailwind class at the call site. A box-shadow paints the
 *    element's BORDER BOX, and the mascot is a round character in a transparent
 *    square viewBox — so `shadow-lg` on `<Mascot>` drew a pale square TILE
 *    floating behind the blob. That shipped, and was rejected on sight. Only
 *    drop-shadow derives from the rendered alpha and traces the silhouette.
 *
 * 2. The rule must sit OUTSIDE the `prefers-reduced-motion` block. A shadow is
 *    not motion; folding it in with the bob would flatten the character for
 *    exactly the viewers who asked only for stillness. That is a one-line
 *    mistake to make while tidying the two mascot rules together, and it is
 *    invisible unless you are testing with reduce on.
 *
 * `apps/edge` pins the same pair over its rendered CSS (`system-pages.test.ts`),
 * where the additional trap is `.m-dim`'s competing `filter`.
 */
test("the mascot's shadow follows its silhouette, and survives reduced motion", async () => {
  const { readFile } = await import("node:fs/promises");
  const here = new URL(".", import.meta.url);
  const css = await readFile(new URL("../../app/globals.css", here), "utf8");
  const shell = await readFile(new URL("../../app/auth/auth-shell.tsx", here), "utf8");

  const mascotClass = /<Mascot\s+className="([^"]*)"/.exec(shell)?.[1];
  assert.ok(mascotClass, "expected /auth's shell to mount <Mascot> with a className");
  assert.doesNotMatch(
    mascotClass,
    /(^|\s)(shadow-|drop-shadow-)/,
    `the mascot's call site must not carry an elevation class (got "${mascotClass}"). ` +
      "A box-shadow paints its square border box and draws a tile behind a round character; " +
      "the silhouette shadow belongs on [data-mascot] in globals.css.",
  );

  // Delete every `@media` block first, THEN look for the rule: an anchored
  // regex is not enough, because a rule nested one level in is still at the
  // start of its own line and would match. What is left is the unconditional
  // CSS, which is where this rule has to be.
  const unconditional = css.replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
  assert.match(
    unconditional,
    /\[data-mascot\]\s*\{[^{}]*filter:\s*drop-shadow\(var\(--shadow-mascot\)\)/,
    "[data-mascot] must carry filter: drop-shadow(var(--shadow-mascot)) UNCONDITIONALLY, outside every " +
      "@media block. Nested in one it stops applying to somebody; as a box-shadow it stops following the outline.",
  );
  for (const block of css.matchAll(/@media\s*\(prefers-reduced-motion[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g)) {
    assert.doesNotMatch(
      block[0],
      /filter\s*:/,
      "no prefers-reduced-motion block may set `filter` on anything — reduced motion stops the bob, " +
        "it does not flatten the character.",
    );
  }

  // Both themes, or the shadow vanishes on one of them.
  assert.match(css, /:root\s*\{(?:[^{}])*--shadow-mascot:/, "--shadow-mascot must be defined on :root");
  assert.match(
    css,
    /\[data-theme="dark"\]\s*\{(?:[^{}])*--shadow-mascot:/,
    "--shadow-mascot must be remapped in the dark block, or a dark page gets the warm light shadow",
  );
});
