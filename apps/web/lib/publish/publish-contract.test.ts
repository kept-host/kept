// The publish contract lives in @kept/shared (it is imported by both apps and,
// from E09, by the MCP server). Its tests live here because apps/web is the
// package's consumer and the workspace's only Node test runner.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_PAGE_BYTES,
  PUBLISH_ERROR_CODES,
  STUDIO_ERROR_CODES,
  filesPublishRequestSchema,
  generateAnonToken,
  hashPublisher,
  hashToken,
  htmlPublishRequestSchema,
  publishErrorSchema,
  publishRequestSchema,
  publishResponseSchema,
  replaceResultSchema,
  studioErrorSchema,
  uploadPublishRequestSchema,
  uploadRequestSchema,
  uploadResponseSchema,
} from "@kept/shared";

const UPLOAD_ID = "6f1c2b0e-9d4a-4c3e-8b7f-0a1b2c3d4e5f";

test("the request schema takes html/turnstileToken/reminderEmail and no slug", () => {
  for (const schema of [htmlPublishRequestSchema, publishRequestSchema]) {
    const parsed = schema.parse({
      html: "<!doctype html><title>hi</title>",
      slug: "chosen-by-caller",
    });
    assert.equal("slug" in parsed, false);

    assert.equal(schema.safeParse({ html: "" }).success, false);
    assert.equal(
      schema.safeParse({ html: "x".repeat(MAX_PAGE_BYTES + 1) }).success,
      false,
    );
    assert.equal(
      schema.safeParse({ html: "<p>ok</p>", reminderEmail: "nope" }).success,
      false,
    );
  }
});

test("E08: the html envelope's fields are the pre-E08 three plus E09's provenance", () => {
  assert.deepEqual(Object.keys(htmlPublishRequestSchema.shape).sort(), [
    "html",
    "model",
    "prompt",
    "readme",
    "reminderEmail",
    "remix_of",
    "source_url",
    "title",
    "tool",
    "turnstileToken",
  ]);
});

test("E08: the union accepts each envelope — html, files, upload_id", () => {
  const html = publishRequestSchema.parse({ html: "<p>hi</p>", turnstileToken: "t" });
  assert.equal("html" in html && html.html, "<p>hi</p>");

  const files = publishRequestSchema.parse({
    files: [
      { path: "index.html", content: "<p>hi</p>" },
      { path: "assets/logo.png", content: "iVBORw0KGgo=", encoding: "base64" },
    ],
    spa: true,
    reminderEmail: "me@example.com",
  });
  assert.ok("files" in files && files.files, "files envelope parsed");
  assert.equal(files.files?.length, 2);
  assert.equal("spa" in files && files.spa, true);

  const upload = publishRequestSchema.parse({ upload_id: UPLOAD_ID, spa: false });
  assert.equal("upload_id" in upload && upload.upload_id, UPLOAD_ID);

  // Each branch schema on its own, too.
  assert.ok(filesPublishRequestSchema.safeParse({ files: [{ path: "index.html", content: "" }] }).success);
  assert.ok(uploadPublishRequestSchema.safeParse({ upload_id: UPLOAD_ID }).success);
});

test("E08: the union refuses a mixed or malformed envelope", () => {
  const index = { path: "index.html", content: "<p>hi</p>" };
  const refused: [string, unknown][] = [
    ["html + files", { html: "<p>hi</p>", files: [index] }],
    ["html + upload_id", { html: "<p>hi</p>", upload_id: UPLOAD_ID }],
    ["files + upload_id", { files: [index], upload_id: UPLOAD_ID }],
    ["no content at all", { spa: true }],
    ["empty file list", { files: [] }],
    ["unknown encoding", { files: [{ ...index, encoding: "hex" }] }],
    ["file without content", { files: [{ path: "index.html" }] }],
    ["upload_id not a uuid", { upload_id: "uploads/x.zip" }],
    ["spa not a boolean", { files: [index], spa: "yes" }],
  ];
  for (const [label, body] of refused) {
    assert.equal(publishRequestSchema.safeParse(body).success, false, `${label} must be refused`);
  }
});

test("E08: the nine file-set codes are in the closed enum; the studio has the seven new ones", () => {
  const added = [
    "missing_index",
    "invalid_path",
    "too_many_files",
    "site_too_large",
    "file_too_large",
    "file_type_not_allowed",
    "invalid_file",
    "invalid_archive",
    "upload_not_found",
  ];
  for (const code of added) {
    assert.ok((PUBLISH_ERROR_CODES as readonly string[]).includes(code), `publish: ${code}`);
    // Every publish file-set code has a same-named studio code (Q-new-5).
    assert.ok((STUDIO_ERROR_CODES as readonly string[]).includes(code), `studio: ${code}`);
    assert.equal(publishErrorSchema.safeParse({ error: code, message: "x" }).success, true);
  }
});

test("E08: uploads request and response schemas", () => {
  assert.equal(uploadRequestSchema.safeParse({ size_bytes: 1 }).success, true);
  for (const size_bytes of [0, -1, 1.5, "10"]) {
    assert.equal(uploadRequestSchema.safeParse({ size_bytes }).success, false, `size_bytes ${size_bytes}`);
  }
  const response = {
    upload_id: UPLOAD_ID,
    upload_url: "https://example.r2.cloudflarestorage.com/uploads/x.zip?X-Amz-Signature=abc",
    expires_at: "2026-10-22T12:15:00.000Z",
    max_bytes: 1024,
  };
  assert.deepEqual(uploadResponseSchema.parse(response), response);
});

test("E08: a replace result may list the junk it ignored", () => {
  const parsed = replaceResultSchema.parse({ unchanged: true, ignored: [".DS_Store"] });
  assert.deepEqual(parsed.ignored, [".DS_Store"]);
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

test("the 201 body is pinned to its seven keys — a field cannot be added without this failing", () => {
  // `respond()` builds the body THROUGH this schema, and zod drops unknown keys,
  // so the schema's key set is the wire's key set. E06 task 005 added a title
  // and a channel to the publish path; neither may surface here.
  assert.deepEqual(Object.keys(publishResponseSchema.shape).sort(), [
    "anonToken",
    "claim_url",
    "deduped",
    "expires_at",
    "expires_in",
    "live_url",
    "slug",
  ]);
});

test("the agent routes' flat error and the studio envelope never parse as each other", () => {
  // Two shapes on purpose (E06 Risk 3): `/api/publish` and `/api/anon/*` answer
  // the frozen flat body agents parse; the studio answers the envelope. A body
  // that satisfied both would mean one of them had drifted toward the other.
  const flat = { error: "invalid_request", message: "x" };
  const envelope = { error: { code: "invalid_request", message: "x" } };
  assert.equal(publishErrorSchema.safeParse(flat).success, true);
  assert.equal(studioErrorSchema.safeParse(flat).success, false);
  assert.equal(studioErrorSchema.safeParse(envelope).success, true);
  assert.equal(publishErrorSchema.safeParse(envelope).success, false);
});

test("the anonymous keep's signed-out 401 is still the flat body, byte for byte", async () => {
  // It used to borrow the owner routes' refusal; those now answer the studio
  // envelope, so `/api/anon/:token/keep` owns its own — and it must not change.
  const { signedOut } = await import("../sites/anon-keep");
  const refusal = signedOut();
  assert.equal(refusal.status, 401);
  assert.equal(
    JSON.stringify(refusal.body),
    JSON.stringify({ error: "invalid_request", message: "Sign in to manage this page." }),
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
