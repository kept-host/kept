/**
 * `errorResponse` — the one refusal shape every publish-family route returns.
 *
 * ONE CASE IS HERE THAT IS NOWHERE ELSE: the 429. Agents are the primary caller
 * of this API and an error they cannot parse is an infinite retry loop, so the
 * rate-limit refusal has to carry both a machine-readable `retry_after_seconds`
 * and the standard `Retry-After` header. The shape is asserted here, where it is
 * built; the BRANCH that returns it — E07's governors on `lib/rate-limit` — is
 * provoked against the real database in `./governors.test.ts`.
 *
 * No stores, no database, no network: this file runs everywhere, including CI.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { publishErrorSchema } from "@kept/shared";

import { browserChannel, errorResponse, keptClientFrom } from "./http";

test("a 429 is machine-parseable, and mirrors the retry into the standard header", async () => {
  const message =
    "Too many requests from here (dev drill). Try again in 42 seconds.";
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

test("an anonymous replace is `web` only when the browser says it came from the app itself", () => {
  const replace = (headers: Record<string, string>) =>
    new Request("https://app.kept-dev.xyz/api/anon/t/replace", { method: "POST", headers });

  // The `/p/:token` manage screen: the browser computes this header, a script cannot.
  assert.equal(browserChannel(replace({ "sec-fetch-site": "same-origin" })), "web");
  // Everything else is an API caller: `curl`, an agent, a hosted page, another site.
  assert.equal(browserChannel(replace({})), "api");
  assert.equal(browserChannel(replace({ "sec-fetch-site": "same-site" })), "api");
  assert.equal(browserChannel(replace({ "sec-fetch-site": "cross-site" })), "api");
  assert.equal(browserChannel(replace({ "sec-fetch-site": "none" })), "api");
});

test("`X-Kept-Client` is kept only when it is a valid label, and never refused (E09 D9)", () => {
  const withClient = (value?: string) =>
    new Request("https://app.kept.test/api/publish", {
      method: "POST",
      headers: value === undefined ? {} : { "x-kept-client": value },
    });

  assert.equal(keptClientFrom(withClient("codex/skill")), "codex/skill");
  assert.equal(keptClientFrom(withClient("claude-code/mcp")), "claude-code/mcp");
  assert.equal(keptClientFrom(withClient()), null);
  // Not lowercased or trimmed into validity: dropped.
  assert.equal(keptClientFrom(withClient("Codex")), null);
  assert.equal(keptClientFrom(withClient("a b")), null);
  assert.equal(keptClientFrom(withClient("x".repeat(41))), null);
});
