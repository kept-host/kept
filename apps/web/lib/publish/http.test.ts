/**
 * `errorResponse` — the one refusal shape every publish-family route returns.
 *
 * ONE CASE IS HERE THAT IS NOWHERE ELSE: the 429. Agents are the primary caller
 * of this API and an error they cannot parse is an infinite retry loop, so the
 * rate-limit refusal has to carry both a machine-readable `retry_after_seconds`
 * and the standard `Retry-After` header. The BRANCH that returns it cannot be
 * provoked end to end while E07's `checkRateLimit` stub is permissive by design
 * (`lib/publish/hooks.ts` returns `{ allowed: true }` unconditionally), and
 * faking it would mean mocking. So the shape is asserted where it is built —
 * against the real function, with no stubs — and E07 owns exercising the branch
 * when it fills the governor in.
 *
 * No stores, no database, no network: this file runs everywhere, including CI.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { publishErrorSchema } from "@kept/shared";

import { errorResponse } from "./http";

test("a 429 is machine-parseable, and mirrors the retry into the standard header", async () => {
  const message =
    "Too many pages published from here (dev drill). Try again in 42 seconds.";
  const res = errorResponse(429, {
    error: "rate_limited",
    message,
    retry_after_seconds: 42,
  });

  assert.equal(res.status, 429);
  // The header an HTTP client backs off on without parsing a body at all.
  assert.equal(res.headers.get("retry-after"), "42");
  // A token or an error body is the easiest thing in a system to end up in a
  // log, so neither may be cached anywhere between here and the caller.
  assert.equal(res.headers.get("cache-control"), "no-store");

  const body = publishErrorSchema.parse(await res.json());
  assert.equal(body.error, "rate_limited");
  assert.equal(body.retry_after_seconds, 42);
  // Human-readable, not a restated code.
  assert.equal(body.message, message);
});

test("an error without a retry carries no Retry-After to mislead a client", async () => {
  const res = errorResponse(400, {
    error: "empty_page",
    message: "The page is empty. Send an HTML document in the `html` field.",
  });

  assert.equal(res.status, 400);
  assert.equal(res.headers.get("retry-after"), null);
  assert.equal(publishErrorSchema.parse(await res.json()).error, "empty_page");
});
