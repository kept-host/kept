/**
 * `verifyTurnstile` against the REAL siteverify endpoint (E06a task 001, AC17).
 *
 * NO MOCKS: Cloudflare's published test secrets make siteverify answer with a
 * fixed verdict, so both branches are exercised over the network. Needs only
 * outbound HTTPS — no secrets, so it runs in CI too.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { TURNSTILE_TEST_KEYS, setTurnstileTestKeys } from "../testing/turnstile";
import { verifyTurnstile } from "./hooks";

const saved = {
  secret: process.env.TURNSTILE_SECRET_KEY,
  site: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
};

afterEach(() => {
  for (const [key, value] of [
    ["TURNSTILE_SECRET_KEY", saved.secret],
    ["NEXT_PUBLIC_TURNSTILE_SITE_KEY", saved.site],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("the always-pass test secret verifies a token", async () => {
  setTurnstileTestKeys("pass");
  assert.deepEqual(await verifyTurnstile(TURNSTILE_TEST_KEYS.dummyToken, "203.0.113.7"), {
    ok: true,
  });
});

test("the always-fail test secret is refused with siteverify's error code", async () => {
  setTurnstileTestKeys("fail");
  const result = await verifyTurnstile(TURNSTILE_TEST_KEYS.dummyToken);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.includes("invalid-input-response"), JSON.stringify(result));
});

test("a missing secret fails closed instead of waving the token through", async () => {
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  assert.deepEqual(await verifyTurnstile(TURNSTILE_TEST_KEYS.dummyToken), {
    ok: false,
    reason: "verification unavailable",
  });
});
