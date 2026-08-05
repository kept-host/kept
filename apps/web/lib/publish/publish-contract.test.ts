// The publish contract lives in @kept/shared (it is imported by both apps and,
// from E08, by the MCP server). Its tests live here because apps/web is the
// package's consumer and the workspace's only Node test runner.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_PAGE_BYTES,
  generateAnonToken,
  hashPublisher,
  hashToken,
  publishErrorSchema,
  publishRequestSchema,
  publishResponseSchema,
} from "@kept/shared";

test("the request schema takes html/turnstileToken/reminderEmail and no slug", () => {
  const parsed = publishRequestSchema.parse({
    html: "<!doctype html><title>hi</title>",
    slug: "chosen-by-caller",
  });
  assert.equal("slug" in parsed, false);

  assert.equal(publishRequestSchema.safeParse({ html: "" }).success, false);
  assert.equal(
    publishRequestSchema.safeParse({ html: "x".repeat(MAX_PAGE_BYTES + 1) })
      .success,
    false,
  );
  assert.equal(
    publishRequestSchema.safeParse({ html: "<p>ok</p>", reminderEmail: "nope" })
      .success,
    false,
  );
});

test("the response schema carries exactly the seven wire fields", () => {
  const body = {
    live_url: "https://calm-fox-42.kept.host",
    claim_url: "https://kept.host/keep/tok",
    slug: "calm-fox-42",
    anonToken: "tok",
    expires_in: "7d",
    expires_at: "2026-08-12T11:00:00.000Z",
    deduped: false,
  };
  assert.deepEqual(publishResponseSchema.parse(body), body);
});

test("the error schema is a closed code enum with an optional backoff", () => {
  assert.deepEqual(
    publishErrorSchema.parse({
      error: "rate_limited",
      message: "Too many publishes. Try again in 30 seconds.",
      retry_after_seconds: 30,
    }).retry_after_seconds,
    30,
  );
  assert.equal(
    publishErrorSchema.safeParse({ error: "kaboom", message: "x" }).success,
    false,
  );
});

test("anon tokens are 32 base64url bytes and unique", () => {
  const tokens = new Set<string>();
  for (let i = 0; i < 1_000; i++) {
    const token = generateAnonToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    tokens.add(token);
  }
  assert.equal(tokens.size, 1_000);
});

test("hashToken is a deterministic SHA-256 hex digest", async () => {
  const token = generateAnonToken();
  const hash = await hashToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, await hashToken(token));
  assert.notEqual(hash, await hashToken(generateAnonToken()));
  assert.notEqual(hash, token);
});

test("hashPublisher is salted and never echoes the raw IP", async () => {
  const hash = await hashPublisher("203.0.113.7", "curl/8.4.0", "salt-a");
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, await hashPublisher("203.0.113.7", "curl/8.4.0", "salt-a"));
  assert.notEqual(
    hash,
    await hashPublisher("203.0.113.7", "curl/8.4.0", "salt-b"),
  );
  assert.notEqual(
    hash,
    await hashPublisher("203.0.113.8", "curl/8.4.0", "salt-a"),
  );
  assert.equal(hash.includes("203"), false);
});
