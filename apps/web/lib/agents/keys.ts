/**
 * API keys (E09 D6): free, created in Settings (or by an agent's emailed code,
 * task 007), shown once, stored only as their SHA-256, revocable, and
 * `API_KEYS_PER_ACCOUNT` live per account.
 *
 * THE ONE BEARER RESOLVER. Every keyed transport — `/api/v1/*` (008), the MCP
 * server (009) and the closed deploy's `key` door (`lib/launch-access.ts`) —
 * asks `keyCallerFrom`, so "what is a key" has one answer.
 *
 * ⚠️ A RAW KEY IS NEVER LOGGED, STORED OR RETURNED TWICE. `createKey` hands it
 * back once for the response that shows it; everything after that knows only
 * the digest and the 13-character display prefix.
 */
import {
  AGENT_RATE_LIMITS,
  API_KEY_DISPLAY_PREFIX_CHARS,
  apiKeyNameSchema,
  apiKeyPattern,
  generateApiKey,
  hashApiKey,
  type ApiKeySummary,
  type Plan,
} from "@kept/shared";
import { z } from "zod";

import {
  findActiveKeyByHash,
  insertApiKey,
  listApiKeys,
  revokeApiKey,
  touchKeyLastUsed,
  type ApiKeyRow,
} from "../db/queries/api-keys";
import { hit, type RateLimitResult } from "../rate-limit";

/** `POST /api/keys`'s body. */
export const createKeyRequestSchema = z.object({ name: apiKeyNameSchema });

/** Who a valid key speaks for. The plan is always the owner's profile plan (Q15). */
export interface KeyCaller {
  keyId: string;
  profileId: string;
  plan: Plan;
}

/** `Authorization: Bearer <credential>`; the credential is checked against `apiKeyPattern`. */
const BEARER = /^Bearer\s+(\S+)$/i;

/** A key row on the wire — `apiKeySummarySchema`'s shape. */
function toSummary(row: ApiKeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    created_at: row.createdAt.toISOString(),
    last_used_on: row.lastUsedOn,
  };
}

/**
 * Mint a key for the account. `null` when it already holds
 * `API_KEYS_PER_ACCOUNT` live keys (the caller answers `key_limit_reached`).
 * `apiKey` is the only copy of the raw key that will ever exist.
 */
export async function createKey(
  profileId: string,
  name: string,
): Promise<{ summary: ApiKeySummary; apiKey: string } | null> {
  const apiKey = generateApiKey();
  const row = await insertApiKey(profileId, {
    name: apiKeyNameSchema.parse(name),
    prefix: apiKey.slice(0, API_KEY_DISPLAY_PREFIX_CHARS),
    hash: await hashApiKey(apiKey),
  });
  return row ? { summary: toSummary(row), apiKey } : null;
}

/** The account's live keys, newest first — never a key or a hash. */
export async function listKeys(profileId: string): Promise<ApiKeySummary[]> {
  return (await listApiKeys(profileId)).map(toSummary);
}

/**
 * Revoke one of the account's keys. `false` when the account owns no key with
 * this id — another account's id and a malformed one read the same.
 */
export async function revokeKey(profileId: string, keyId: string): Promise<boolean> {
  if (!z.string().uuid().safeParse(keyId).success) return false;
  return revokeApiKey(keyId, profileId);
}

/**
 * The key a request carries, or `null`. Only `Authorization: Bearer kpt_live_…`
 * counts — never a cookie. Looked up by digest on every request (no cache), so
 * a revoked key fails on its very next use; a hit stamps `last_used_on`, at
 * most one write a day.
 */
export async function keyCallerFrom(request: Request): Promise<KeyCaller | null> {
  const credential = bearerApiKey(request);
  if (credential === null) return null;

  const caller = await findActiveKeyByHash(await hashApiKey(credential));
  if (caller) await touchKeyLastUsed(caller.keyId);
  return caller;
}

/**
 * The well-formed `kpt_live_…` credential the request's Bearer header carries,
 * or `null` — not yet looked up. The MCP door (009) uses it to tell "no key"
 * (keyless) from "a key that resolves to nothing" (401).
 */
export function bearerApiKey(request: Request): string | null {
  const credential = BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
  return credential !== undefined && apiKeyPattern.test(credential) ? credential : null;
}

/** Count one keyed publish or replace against the key's hourly bucket (D6). */
export function checkKeyLimit(keyId: string): Promise<RateLimitResult> {
  return hit(`key:${keyId}`, AGENT_RATE_LIMITS.perKeyHour);
}
