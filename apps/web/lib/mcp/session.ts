/**
 * MCP session ids, signed and verified with no server-side state (E09 D5).
 *
 * `Mcp-Session-Id = base64url(random16) + "." + base64url(HMAC-SHA256(MCP_SESSION_SECRET, random16))`
 *
 * The SDK's stateful transport keeps sessions in an in-memory map, which a
 * second Railway instance (or a restart) does not share (Risk 1). So the
 * transport runs STATELESS and the session lives in the id itself: minted on
 * `initialize`, verified in constant time on every later request. A forged or
 * altered id is 404 — the transport's "session not found" — and a missing one
 * on a non-initialize request is 400.
 *
 * WHAT THE SESSION IS FOR: the keyless publisher identity. Hosted agents share
 * cloud egress IPs, so an IP-keyed dedup could hand one user another's claim
 * link (D5). The publisher key is `SHA-256(PUBLISHER_HASH_SALT ‖ random)`:
 * dedup and E07's per-publisher buckets never cross sessions.
 *
 * ⚠️ A SESSION ID, ITS RANDOM HALF AND ITS MAC ARE NEVER LOGGED.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { hashToken } from "@kept/shared";

import { mcpSessionSecret, publisherHashSalt } from "../storage/env";

/** The header the Streamable HTTP transport carries the session in (lowercase, as `Headers` reads it). */
export const MCP_SESSION_HEADER = "mcp-session-id";

const RANDOM_BYTES = 16;

/** base64url of 16 bytes is 22 characters; of a SHA-256 MAC, 43. */
const SESSION_ID = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

function mac(random: Buffer, secret: string): Buffer {
  return createHmac("sha256", secret).update(random).digest();
}

/** A fresh, signed session id — the `initialize` response's `Mcp-Session-Id`. */
export function mintSessionId(secret: string = mcpSessionSecret()): string {
  const random = randomBytes(RANDOM_BYTES);
  return `${random.toString("base64url")}.${mac(random, secret).toString("base64url")}`;
}

/**
 * The session's random half (base64url) when `id` carries a valid MAC, else
 * `null`. The MAC is compared in constant time; a malformed id never reaches
 * the comparison.
 */
export function verifySessionId(id: string, secret: string = mcpSessionSecret()): string | null {
  const parts = SESSION_ID.exec(id);
  if (!parts) return null;
  const random = Buffer.from(parts[1]!, "base64url");
  const given = Buffer.from(parts[2]!, "base64url");
  // Re-encoding must round-trip: base64url has non-canonical spellings of the
  // last character, and two spellings of one id would be two sessions.
  if (random.length !== RANDOM_BYTES || random.toString("base64url") !== parts[1]) return null;
  if (given.toString("base64url") !== parts[2]) return null;
  const expected = mac(random, secret);
  return given.length === expected.length && timingSafeEqual(given, expected) ? parts[1]! : null;
}

/** The request's session: its random half, or the status the transport answers (400 missing, 404 invalid). */
export type SessionCheck = { ok: true; session: string } | { ok: false; status: 400 | 404 };

/** Read and verify the `Mcp-Session-Id` a non-initialize request carries. */
export function sessionFrom(request: Request): SessionCheck {
  const id = request.headers.get(MCP_SESSION_HEADER);
  if (id === null || id.length === 0) return { ok: false, status: 400 };
  const session = verifySessionId(id);
  return session === null ? { ok: false, status: 404 } : { ok: true, session };
}

/** The session's random half, from an id this server just minted. */
export function sessionOf(id: string): string {
  return id.slice(0, id.indexOf("."));
}

/** `PublisherContext.publisherKey` for a keyless session: `SHA-256(salt ‖ random)`, hex. */
export function sessionPublisherKey(session: string): Promise<string> {
  return hashToken(publisherHashSalt() + session);
}
