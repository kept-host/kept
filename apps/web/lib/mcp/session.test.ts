/**
 * Signed MCP session ids (E09 D5, AC6) — pure: no network, no database.
 *
 *   pnpm --filter @kept/web exec tsx --test lib/mcp/session.test.ts
 *
 * The secret and salt here are throwaway literals filled only when the
 * environment has none; nothing is printed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { mintSessionId, sessionFrom, sessionOf, sessionPublisherKey, verifySessionId } from "./session";

const SECRET = "e09-009-session-test-secret-0123456789abcdef";
const OTHER = "e09-009-another-session-secret-0123456789abcdef";
process.env.MCP_SESSION_SECRET ??= SECRET;
process.env.PUBLISHER_HASH_SALT ??= "e09-009-session-test-salt";

/** Swap one character of `text` at `index` for a different base64url character. */
function flip(text: string, index: number): string {
  const swapped = text[index] === "A" ? "B" : "A";
  return text.slice(0, index) + swapped + text.slice(index + 1);
}

function withSession(id: string | null): Request {
  return new Request("https://kept.test/mcp", { method: "POST", headers: id === null ? {} : { "mcp-session-id": id } });
}

test("a minted id is random16.mac and verifies to its random half", () => {
  const id = mintSessionId(SECRET);
  assert.match(id, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(verifySessionId(id, SECRET), sessionOf(id));
  assert.notEqual(mintSessionId(SECRET), id, "every initialize gets its own session");
});

test("a tampered random half, a tampered MAC or another secret's MAC does not verify", () => {
  const id = mintSessionId(SECRET);
  const dot = id.indexOf(".");
  assert.equal(verifySessionId(flip(id, 0), SECRET), null, "random half altered");
  assert.equal(verifySessionId(flip(id, dot + 1), SECRET), null, "MAC altered");
  assert.equal(verifySessionId(id, OTHER), null, "signed with another secret");
  // A session made up by the caller, with a well-formed but self-chosen MAC.
  assert.equal(verifySessionId(`${id.slice(0, dot)}.${"A".repeat(43)}`, SECRET), null);
});

test("malformed ids never reach the comparison", () => {
  const id = mintSessionId(SECRET);
  for (const bad of ["", "abc", id.replace(".", ""), `${id}.x`, `${id}=`, id.slice(0, -1), ` ${id}`]) {
    assert.equal(verifySessionId(bad, SECRET), null, `refused: ${bad.length} chars`);
  }
  // A non-canonical spelling of the last character decodes to the same bytes; it is not the same id.
  const last = id.at(-1)!;
  const sibling = String.fromCharCode(last.charCodeAt(0) ^ 1);
  if (/[A-Za-z0-9_-]/.test(sibling)) assert.equal(verifySessionId(id.slice(0, -1) + sibling, SECRET), null);
});

test("sessionFrom: missing → 400, tampered → 404, valid → the random half (env secret)", () => {
  assert.deepEqual(sessionFrom(withSession(null)), { ok: false, status: 400 });
  assert.deepEqual(sessionFrom(withSession("")), { ok: false, status: 400 });
  const id = mintSessionId();
  assert.deepEqual(sessionFrom(withSession(flip(id, 3))), { ok: false, status: 404 });
  assert.deepEqual(sessionFrom(withSession(id)), { ok: true, session: sessionOf(id) });
});

test("the publisher key is per session and never the raw session", async () => {
  const a = sessionOf(mintSessionId());
  const b = sessionOf(mintSessionId());
  const keyA = await sessionPublisherKey(a);
  assert.match(keyA, /^[0-9a-f]{64}$/);
  assert.equal(await sessionPublisherKey(a), keyA, "stable within a session");
  assert.notEqual(await sessionPublisherKey(b), keyA, "dedup never crosses sessions");
  assert.ok(!keyA.includes(a));
});
