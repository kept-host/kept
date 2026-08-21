/**
 * `gazeToward` and the `MascotOptions.gaze` it feeds.
 *
 * ── WHAT IS ACTUALLY AT RISK ───────────────────────────────────────────────
 * Two things, and neither is "does the arithmetic add up".
 *
 * **The envelope.** `KEPT_EYE_INSET = 0.9` exists because at 1.15 the outer eye
 * crossed the silhouette and the mask cropped it to a crescent stuck on the
 * rim. A gaze that swings too far reopens exactly that defect, and it reopens
 * it on the Worker's 404 page, at 170 px, where nobody is looking. So the
 * envelope is clamped in one place — `gazeToward` — and this file asserts that
 * the clamp holds for inputs at, beyond and far beyond ±1, that the bounds are
 * non-zero (a silently-zero envelope is a mascot that has quietly stopped
 * tracking), and that both eyes survive at all four corners of it.
 *
 * **The default path.** `apps/edge` renders one frozen frame of this generator
 * and its vitest pins the emitted `d`; `apps/web` renders the same frame under
 * `prefers-reduced-motion`. Adding an option must not move either of them by a
 * byte. The digests below were captured from the generator BEFORE
 * `MascotOptions.gaze` existed, by running the pre-change `mascotFrame` and
 * `mascotSvg` and hashing the exact strings they returned; they are the whole
 * point of the file. If one fails, the no-gaze default has stopped being the
 * rest gaze and every consumer's character has changed.
 *
 * Nothing here mocks anything, needs credentials or touches a network: the
 * generator is a pure function of `(t, opts)` and this calls it.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  KEPT_REST_GAZE,
  KEPT_TRACK_PITCH,
  KEPT_TRACK_YAW,
  MASCOT_REST_T,
  gazeToward,
  mascotFrame,
  mascotSvg,
} from "@kept/shared/mascot";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

test("gazeToward(0, 0) is exactly the rest gaze", () => {
  assert.deepEqual(
    gazeToward(0, 0),
    KEPT_REST_GAZE,
    "a pointer sitting on the mascot's centre must produce the resting character, not an " +
      "approximation of it — the tracking consumer passes this on every frame.",
  );
});

test("the tracking envelope is real, bounded and yaw/pitch only", () => {
  assert.ok(
    KEPT_TRACK_YAW > 0 && KEPT_TRACK_PITCH > 0,
    "a zero bound is a mascot that has silently stopped tracking; both were derived by rendering " +
      "the four corners at 300 px and at the Worker's 170 px.",
  );
  // The envelope was chosen one step inside where the outer eye stops reading
  // as an eye (±16 flattens it onto the flank, ±20 is a smudge on the rim).
  assert.ok(
    KEPT_TRACK_YAW <= 16 && KEPT_TRACK_PITCH <= 12,
    "widening the envelope past the values the render sheet cleared reopens the KEPT_EYE_INSET " +
      "crescent. Re-render the corners before changing these.",
  );

  for (const [nx, ny] of [
    [1, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [3, -3],
    [-1e9, 1e9],
    [Infinity, -Infinity],
  ] as const) {
    const g = gazeToward(nx, ny);
    assert.ok(
      Math.abs(g.yaw - KEPT_REST_GAZE.yaw) <= KEPT_TRACK_YAW + 1e-9,
      `gazeToward(${nx}, ${ny}) left the yaw envelope: ${g.yaw}`,
    );
    assert.ok(
      Math.abs(g.pitch - KEPT_REST_GAZE.pitch) <= KEPT_TRACK_PITCH + 1e-9,
      `gazeToward(${nx}, ${ny}) left the pitch envelope: ${g.pitch}`,
    );
    assert.equal(
      g.roll,
      KEPT_REST_GAZE.roll,
      "the head-cock is a characteristic of the face, not part of where it is looking; tracking " +
        "is yaw and pitch only.",
    );
  }

  // Saturation, not overflow: past ±1 the gaze stops moving.
  assert.deepEqual(gazeToward(2, 2), gazeToward(1, 1));
  assert.deepEqual(gazeToward(-40, 7), gazeToward(-1, 1));
});

test("gazeToward reaches its bounds at exactly ±1, and the signs point at the pointer", () => {
  // nx grows right and yaw is positive to the viewer's right.
  assert.equal(gazeToward(1, 0).yaw, KEPT_REST_GAZE.yaw + KEPT_TRACK_YAW);
  assert.equal(gazeToward(-1, 0).yaw, KEPT_REST_GAZE.yaw - KEPT_TRACK_YAW);
  // ny grows DOWNWARD (every pointer coordinate does) and pitch is positive up,
  // so a pointer below the mascot must lower the gaze.
  assert.equal(gazeToward(0, 1).pitch, KEPT_REST_GAZE.pitch - KEPT_TRACK_PITCH);
  assert.equal(gazeToward(0, -1).pitch, KEPT_REST_GAZE.pitch + KEPT_TRACK_PITCH);
});

test("gazeToward is pure and symmetric about the rest gaze", () => {
  for (const [nx, ny] of [
    [0.25, -0.75],
    [-0.5, 0.5],
    [0.9, 0.1],
    [1, 1],
  ] as const) {
    assert.deepEqual(gazeToward(nx, ny), gazeToward(nx, ny), "same input, same output, always");

    const a = gazeToward(nx, ny);
    const b = gazeToward(-nx, -ny);
    assert.ok(
      Math.abs(a.yaw - KEPT_REST_GAZE.yaw + (b.yaw - KEPT_REST_GAZE.yaw)) < 1e-12 &&
        Math.abs(a.pitch - KEPT_REST_GAZE.pitch + (b.pitch - KEPT_REST_GAZE.pitch)) < 1e-12,
      `gazeToward(${nx}, ${ny}) and its mirror are not equal and opposite about the rest gaze`,
    );
  }

  // Linear in between, so a pointer halfway across the element is halfway
  // through the envelope rather than snapping to it.
  assert.equal(gazeToward(0.5, 0).yaw, KEPT_REST_GAZE.yaw + KEPT_TRACK_YAW / 2);
  assert.equal(gazeToward(0, 0.5).pitch, KEPT_REST_GAZE.pitch - KEPT_TRACK_PITCH / 2);
});

test("both eyes survive at every corner of the envelope, at every sampled instant", () => {
  const corners = [
    [0, 0],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const;

  for (const [nx, ny] of corners) {
    const gaze = gazeToward(nx, ny);
    for (let t = 0; t < 40; t += 0.25) {
      const { eyes } = mascotFrame(t, { maskId: "envelope", gaze });
      assert.equal(
        eyes.length,
        2,
        `corner (${nx}, ${ny}) at t=${t} culled an eye: the far-side cull fired, which means the ` +
          `head turned past ~90° and the envelope is far wider than it was derived to be.`,
      );
      for (const e of eyes) {
        assert.equal(
          /NaN|Infinity/.test(e.transform),
          false,
          `corner (${nx}, ${ny}) at t=${t} emitted a non-finite matrix: ${e.transform}`,
        );
      }
    }
  }
});

test("a supplied gaze actually moves the eyes, and only the eyes", () => {
  const rest = mascotFrame(MASCOT_REST_T, { maskId: "m" });
  const looking = mascotFrame(MASCOT_REST_T, { maskId: "m", gaze: gazeToward(1, -1) });

  assert.equal(
    looking.d,
    rest.d,
    "the gaze is the head's orientation; the body outline is not a function of it, so the " +
      "silhouette must be byte-identical and an animated consumer can keep one path element.",
  );
  assert.notDeepEqual(
    looking.eyes,
    rest.eyes,
    "MascotOptions.gaze did nothing — the option is wired to nothing and the tracking wrapper " +
      "would silently render the resting character.",
  );
});

test("passing the rest gaze explicitly is the same frame as passing none", () => {
  for (const t of [0, 2.15, MASCOT_REST_T, 601.25]) {
    assert.deepEqual(
      mascotFrame(t, { maskId: "m", gaze: KEPT_REST_GAZE }),
      mascotFrame(t, { maskId: "m" }),
      `t=${t}: the default must be KEPT_REST_GAZE itself, not a copy that has drifted from it.`,
    );
  }
});

/**
 * The digests, captured from the generator before `MascotOptions.gaze` existed.
 *
 * `apps/edge`'s vitest pins the emitted `d` at 32 and 64 samples against a
 * frozen `MASCOT_REST_T`; these pin the same strings from this side, plus a
 * mid-blink instant (t = 2.15, where `blinkScale` is squashing the eyes) and a
 * far-future one (t = 601.25, past the 20-minute blink calendar's first wrap),
 * because a bug in the gaze default would show up in the drift term long before
 * it showed up at rest.
 */
test("the no-gaze path is byte-identical to the generator before gaze existed", () => {
  const pins: [string, string, string][] = [
    [
      "mascotFrame(18.45, { maskId: 'm', samples: 64 })",
      JSON.stringify(mascotFrame(MASCOT_REST_T, { maskId: "m", samples: 64 })),
      "531db9e3c076afb1706924a4bc44f662ba8bdcfd6d9d6502cc3cefb0b9356862",
    ],
    [
      "mascotFrame(18.45, { maskId: 'm', samples: 32 })",
      JSON.stringify(mascotFrame(MASCOT_REST_T, { maskId: "m", samples: 32 })),
      "8592b7a114d0ae6001ec4aa7b7f1ccec2414d269aa38206196276ab153c77985",
    ],
    [
      "mascotFrame(2.15, { maskId: 'm', samples: 64 })",
      JSON.stringify(mascotFrame(2.15, { maskId: "m", samples: 64 })),
      "3ee794e1d7df462ca510719659faa9ac9bf0f6bdbd2c3f98402c259f10fc4e41",
    ],
    [
      "mascotFrame(0, { maskId: 'm', samples: 64 })",
      JSON.stringify(mascotFrame(0, { maskId: "m", samples: 64 })),
      "8231905f2f5cf27a4f419fd63148742165b3071caf0a5dc41ffa200d8bcf9a14",
    ],
    [
      "mascotFrame(601.25, { maskId: 'm', samples: 64 })",
      JSON.stringify(mascotFrame(601.25, { maskId: "m", samples: 64 })),
      "a92d32d8e1b90a6c136c4ea04a1462b08e13f6aa29e29990697264020ee85b70",
    ],
    [
      "mascotSvg(18.45, { maskId: 'm' })",
      mascotSvg(MASCOT_REST_T, { maskId: "m" }),
      "f2e365277aed91b33a73f77134fc4df91c0b477ac71fb8c6df50de431fe10eee",
    ],
  ];

  for (const [label, actual, digest] of pins) {
    assert.equal(
      sha(actual),
      digest,
      `${label} changed. The generator emitted:\n${actual}\n\nThis frame is what apps/edge ` +
        `serves on every 404 and what apps/web renders under prefers-reduced-motion. If the ` +
        `character was deliberately re-tuned, re-capture every digest in this test in the same ` +
        `commit; if not, the gaze default has stopped being KEPT_REST_GAZE.`,
    );
  }

  // The gaze-sensitive half of that frame, spelled out: a digest tells you
  // something moved, these tell you it was the eyes.
  const { eyes } = mascotFrame(MASCOT_REST_T, { maskId: "m" });
  assert.deepEqual(
    eyes.map((e) => e.transform),
    [
      "matrix(0.78,0.11,-0.25,0.96,-46.05,-21.36)",
      "matrix(0.97,0.1,-0.06,0.98,18.87,-14.74)",
    ],
    "the frozen frame's eye matrices are the rest gaze, the drift at MASCOT_REST_T and the blink " +
      "(fully open there) composed. They are the first thing a wrong gaze default would move.",
  );
});
