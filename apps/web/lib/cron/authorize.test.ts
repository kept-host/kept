/**
 * The `/api/cron/*` shared-secret gate — E05 task 011.
 *
 * NO MOCKS (project rule) and none needed: the guard reads the real
 * `lib/storage/env.ts` accessor, so the test sets the real variable and asserts
 * against the real comparison. No database, no network, no mail.
 *
 * The one property worth a test here is that EVERY rejection is the same
 * rejection — an endpoint that behaves differently for "no header" and "wrong
 * secret" tells an attacker which half they got right.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { isAuthorizedCronRequest } from "./authorize";

const SECRET = "cron-test-secret-of-more-than-32-characters";

let previous: string | undefined;

beforeEach(() => {
  previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
});

afterEach(() => {
  if (previous === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previous;
});

const request = (authorization?: string) =>
  new Request("https://example.test/api/cron/draft-reminder", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });

describe("isAuthorizedCronRequest", () => {
  test("accepts the configured secret as a bearer token", () => {
    assert.equal(isAuthorizedCronRequest(request(`Bearer ${SECRET}`)), true);
  });

  test("accepts the scheme case-insensitively, as RFC 7235 requires", () => {
    assert.equal(isAuthorizedCronRequest(request(`bearer ${SECRET}`)), true);
  });

  test("rejects an absent Authorization header", () => {
    assert.equal(isAuthorizedCronRequest(request()), false);
  });

  test("rejects a wrong secret of the same length", () => {
    const wrong = "X".repeat(SECRET.length);
    assert.equal(wrong.length, SECRET.length);
    assert.equal(isAuthorizedCronRequest(request(`Bearer ${wrong}`)), false);
  });

  test("rejects a correct prefix — no partial credit", () => {
    assert.equal(isAuthorizedCronRequest(request(`Bearer ${SECRET.slice(0, -1)}`)), false);
  });

  test("rejects the secret without the Bearer scheme", () => {
    assert.equal(isAuthorizedCronRequest(request(SECRET)), false);
  });

  test("rejects Basic auth carrying the secret", () => {
    assert.equal(isAuthorizedCronRequest(request(`Basic ${SECRET}`)), false);
  });

  test("throws — rather than allowing — when CRON_SECRET is unset", () => {
    delete process.env.CRON_SECRET;
    assert.throws(
      () => isAuthorizedCronRequest(request(`Bearer ${SECRET}`)),
      /CRON_SECRET/,
    );
  });

  test("throws when CRON_SECRET is present but blank", () => {
    // The normal shape of an unfilled Railway variable. It must fail loudly,
    // never collapse to "any secret is fine".
    process.env.CRON_SECRET = "   ";
    assert.throws(() => isAuthorizedCronRequest(request("Bearer anything")), /CRON_SECRET/);
  });

  test("rejects an empty bearer value before reading the environment", () => {
    delete process.env.CRON_SECRET;
    // `Headers` trims the value, so this never reaches the secret at all —
    // which is the property that matters: no header, no work.
    assert.equal(isAuthorizedCronRequest(request("Bearer    ")), false);
  });
});
