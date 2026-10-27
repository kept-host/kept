/**
 * The publish pause switch — E09 task 011.
 *
 * `publishPaused()` reads `KEPT_PUBLISH_PAUSED` on every call (an operator flips
 * it on Railway without a rebuild), and only the exact string `true`, trimmed,
 * pauses. Each case sets the variable and asserts the very next call sees it —
 * which is also the proof that nothing is cached at module load.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { publishPaused } from "./launch";

const original = process.env.KEPT_PUBLISH_PAUSED;

afterEach(() => {
  if (original === undefined) delete process.env.KEPT_PUBLISH_PAUSED;
  else process.env.KEPT_PUBLISH_PAUSED = original;
});

test("publishPaused: unset is publishing on", () => {
  delete process.env.KEPT_PUBLISH_PAUSED;
  assert.equal(publishPaused(), false);
});

test("publishPaused: exactly `true` pauses", () => {
  process.env.KEPT_PUBLISH_PAUSED = "true";
  assert.equal(publishPaused(), true);
});

test("publishPaused: surrounding whitespace is trimmed", () => {
  process.env.KEPT_PUBLISH_PAUSED = "  true\n";
  assert.equal(publishPaused(), true);
});

for (const value of ["TRUE", "True", "false", "1", "yes", "", "   "]) {
  test(`publishPaused: ${JSON.stringify(value)} is publishing on`, () => {
    process.env.KEPT_PUBLISH_PAUSED = value;
    assert.equal(publishPaused(), false);
  });
}

test("publishPaused: read per call — a flip is seen by the next call", () => {
  process.env.KEPT_PUBLISH_PAUSED = "true";
  assert.equal(publishPaused(), true);
  process.env.KEPT_PUBLISH_PAUSED = "false";
  assert.equal(publishPaused(), false);
});
