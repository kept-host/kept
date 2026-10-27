/**
 * E09 task 001 — the agent contract in `@kept/shared` (./agents, ./provenance).
 *
 * Lives in `apps/web` because `packages/shared` has no test runner (precedent:
 * `lib/plans/limits.test.ts`). Pure: no store is touched. Real code, no mocks.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  API_KEY_DISPLAY_PREFIX_CHARS,
  API_KEY_PREFIX,
  API_KEYS_PER_ACCOUNT,
  KEYED_ERROR_CODES,
  PAGE_TITLE_MAX_LENGTH,
  PROVENANCE_LIMITS,
  PUBLISH_ERROR_CODES,
  agentCodeVerifySchema,
  apiKeyCreatedSchema,
  apiKeyPattern,
  generateApiKey,
  hashApiKey,
  hashToken,
  htmlPublishRequestSchema,
  keyedErrorSchema,
  parseKeptClient,
  publishErrorSchema,
  publishRequestSchema,
} from "@kept/shared";

test("a generated key matches the pattern, is unique, and hashes like an anon token", async () => {
  const key = generateApiKey();
  console.log(`[contract] key length ${key.length}, prefix ${key.slice(0, API_KEY_DISPLAY_PREFIX_CHARS)}…`);
  assert.ok(key.startsWith(API_KEY_PREFIX));
  assert.match(key, apiKeyPattern);
  assert.equal(key.length, API_KEY_PREFIX.length + 43);
  assert.notEqual(generateApiKey(), key);

  const hash = await hashApiKey(key);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, await hashToken(key), "one digest helper, not two");
  assert.equal(hash, await hashApiKey(key), "deterministic");

  assert.doesNotMatch(`${API_KEY_PREFIX}short`, apiKeyPattern);
  assert.doesNotMatch(key.replace(API_KEY_PREFIX, "kpt_test_"), apiKeyPattern);
  assert.equal(API_KEYS_PER_ACCOUNT, 25);
});

test("a created key round-trips through its response schema", () => {
  const key = generateApiKey();
  const body = {
    id: "6f1c2b0e-9d4a-4c3e-8b7f-0a1b2c3d4e5f",
    name: "laptop",
    prefix: key.slice(0, API_KEY_DISPLAY_PREFIX_CHARS),
    created_at: "2026-10-27T12:00:00.000Z",
    last_used_on: "2026-10-27",
    api_key: key,
  };
  assert.deepEqual(apiKeyCreatedSchema.parse(body), body);
  assert.equal(
    apiKeyCreatedSchema.safeParse({ ...body, last_used_on: "2026-10-27T12:00:00.000Z" }).success,
    false,
    "last_used_on is a date, not an instant",
  );
});

test("parseKeptClient accepts only [a-z0-9._/-]{1,40} and never throws", () => {
  const table: [string | null, string | null][] = [
    ["codex/skill", "codex/skill"],
    ["claude-code/mcp", "claude-code/mcp"],
    ["cursor/api", "cursor/api"],
    ["a".repeat(40), "a".repeat(40)],
    ["a".repeat(41), null],
    ["Codex/skill", null],
    ["codex skill", null],
    [" codex/skill", null],
    ["", null],
    [null, null],
    ["codex/skill\n", null],
    ["codex;rm", null],
    // Inside the allowed alphabet, so accepted: the value is a count label, never a path.
    ["../", "../"],
  ];
  for (const [raw, expected] of table) {
    assert.equal(parseKeptClient(raw), expected, JSON.stringify(raw));
  }
});

test("provenance caps hold at the limit and refuse limit + 1", () => {
  const caps: [string, number][] = [
    ["title", PAGE_TITLE_MAX_LENGTH],
    ["model", PROVENANCE_LIMITS.model],
    ["tool", PROVENANCE_LIMITS.tool],
    ["prompt", PROVENANCE_LIMITS.prompt],
    ["readme", PROVENANCE_LIMITS.readme],
  ];
  for (const [field, max] of caps) {
    const ok = htmlPublishRequestSchema.safeParse({ html: "<p>hi</p>", [field]: "x".repeat(max) });
    assert.equal(ok.success, true, `${field} at ${max}`);
    const over = htmlPublishRequestSchema.safeParse({ html: "<p>hi</p>", [field]: "x".repeat(max + 1) });
    assert.equal(over.success, false, `${field} at ${max + 1}`);
  }

  const base = "https://example.com/";
  const atLimit = base + "a".repeat(PROVENANCE_LIMITS.source_url - base.length);
  assert.equal(htmlPublishRequestSchema.safeParse({ html: "<p>hi</p>", source_url: atLimit }).success, true);
  assert.equal(
    htmlPublishRequestSchema.safeParse({ html: "<p>hi</p>", source_url: `${atLimit}a` }).success,
    false,
  );
});

test("provenance parses on every envelope; bad URLs and slugs are refused, blanks dropped", () => {
  const provenance = {
    title: "  My page  ",
    model: "claude-opus-4-7",
    tool: "codex",
    source_url: "https://github.com/kept-host/skill",
    remix_of: "calm-fox-42",
  };
  const parsed = publishRequestSchema.parse({
    files: [{ path: "index.html", content: "<p>hi</p>" }],
    ...provenance,
    prompt: "   ",
  });
  assert.equal(parsed.title, "My page", "trimmed");
  assert.equal(parsed.model, "claude-opus-4-7");
  assert.equal(parsed.remix_of, "calm-fox-42");
  assert.equal(parsed.prompt, undefined, "a blank field is not given");
  assert.ok(publishRequestSchema.safeParse({ upload_id: "6f1c2b0e-9d4a-4c3e-8b7f-0a1b2c3d4e5f", ...provenance }).success);

  for (const source_url of ["ftp://example.com/x", "javascript:alert(1)", "not a url"]) {
    assert.equal(htmlPublishRequestSchema.safeParse({ html: "<p>hi</p>", source_url }).success, false, source_url);
  }
  assert.equal(htmlPublishRequestSchema.safeParse({ html: "<p>hi</p>", source_url: "http://example.com" }).success, true);
  assert.equal(htmlPublishRequestSchema.safeParse({ html: "<p>hi</p>", remix_of: "Not A Slug" }).success, false);
});

test("the agent code verify body: six digits, a key name", () => {
  assert.ok(agentCodeVerifySchema.safeParse({ email: "Me@Example.com", code: "012345", keyName: "codex" }).success);
  for (const code of ["12345", "1234567", "12a456", ""]) {
    assert.equal(agentCodeVerifySchema.safeParse({ email: "me@example.com", code, keyName: "k" }).success, false, code);
  }
  assert.equal(agentCodeVerifySchema.safeParse({ email: "me@example.com", code: "123456", keyName: "  " }).success, false);
  assert.equal(
    agentCodeVerifySchema.safeParse({ email: "me@example.com", code: "123456", keyName: "k".repeat(61) }).success,
    false,
  );
});

test("the keyed error enum is closed: the keyless codes plus exactly four", () => {
  assert.ok(PUBLISH_ERROR_CODES.includes("publishing_paused"));
  assert.ok(publishErrorSchema.safeParse({ error: "publishing_paused", message: "x", retry_after_seconds: 600 }).success);

  const own = KEYED_ERROR_CODES.filter((code) => !(PUBLISH_ERROR_CODES as readonly string[]).includes(code));
  assert.deepEqual([...own].sort(), ["invalid_code", "key_limit_reached", "not_allowed_in_status", "not_found", "unauthorized"]);
  assert.equal(KEYED_ERROR_CODES.length, PUBLISH_ERROR_CODES.length + 5);
  for (const code of KEYED_ERROR_CODES) {
    assert.ok(keyedErrorSchema.safeParse({ error: code, message: "x" }).success, code);
  }
  assert.equal(keyedErrorSchema.safeParse({ error: "forbidden", message: "x" }).success, false);
  assert.equal(
    keyedErrorSchema.safeParse({ error: { code: "not_found", message: "x" } }).success,
    false,
    "flat, never the studio envelope",
  );
});
