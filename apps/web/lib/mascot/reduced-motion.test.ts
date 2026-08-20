/**
 * Under `prefers-reduced-motion: reduce` the mascot must start **no**
 * `requestAnimationFrame` loop — not a loop that ticks and discards its output.
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
 * mounts the component, and that route does not exist until task 004 swaps the
 * vessel out of `/auth`. Writing the spec now would mean landing a red spec.
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

import { MASCOT_REST_T } from "@kept/shared/mascot";

import { startMascotLoop } from "../../components/kept/mascot";

/**
 * A scheduler that records instead of scheduling. Not a mock of a service —
 * `requestAnimationFrame` is the one thing this function is being asked a
 * question about, and the question is "how many times did you call it".
 */
function recordingScheduler() {
  let nextHandle = 0;
  let pending: ((now: number) => void) | null = null;
  const record = {
    rafCalls: 0,
    cancelled: [] as number[],
    painted: [] as number[],
    raf(cb: (now: number) => void): number {
      record.rafCalls += 1;
      pending = cb;
      nextHandle += 1;
      return nextHandle;
    },
    caf(handle: number): void {
      record.cancelled.push(handle);
    },
    paint(t: number): void {
      record.painted.push(t);
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

test("reduced motion paints the resting frame and starts no rAF loop", () => {
  const s = recordingScheduler();

  const stop = startMascotLoop(true, s.paint, s.raf, s.caf);

  assert.deepEqual(
    s.painted,
    [MASCOT_REST_T],
    "under reduce the mascot must paint MASCOT_REST_T exactly once — the same instant apps/edge " +
      "freezes into its system pages — and then hold it.",
  );
  assert.equal(
    s.rafCalls,
    0,
    "under prefers-reduced-motion: reduce the component must call requestAnimationFrame ZERO " +
      "times. A loop that ticks and discards its frames is a CPU cost with no visible effect.",
  );

  stop();

  assert.equal(s.rafCalls, 0, "cleanup must not start anything either");
  assert.deepEqual(
    s.cancelled,
    [],
    "there is nothing to cancel: the reduced branch started nothing. Cleanup is still safe to " +
      "call, which is what makes the effect's contract uniform across both branches.",
  );
});

test("with motion allowed the loop runs, advances t from the rAF clock, and cancels on cleanup", () => {
  const s = recordingScheduler();

  const stop = startMascotLoop(false, s.paint, s.raf, s.caf);

  assert.deepEqual(
    s.painted,
    [MASCOT_REST_T],
    "the animated timeline starts at the resting frame, so both audiences see the same pose on " +
      "arrival and only one of them then breathes.",
  );
  assert.equal(s.rafCalls, 1, "exactly one frame is scheduled up front");

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
});
