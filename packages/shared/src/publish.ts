// @kept/shared — the anonymous publish contract (E04).
//
// Request, response and error shapes for `POST /api/publish`, plus the token and
// hash helpers that endpoint needs. It lives here, next to the KV manifest
// contract, because E08's MCP server wraps the endpoint without modifying it: an
// untyped JSON blob drifts the first time either side changes.
//
// Everything in this file is isomorphic. `@kept/shared` is bundled into the
// Worker, so no `node:crypto`, no Node-only or DOM-only global — Web Crypto only.

import { z } from "zod";

import { pageHtmlSchema, slugSchema } from "./schemas";

/**
 * Web Crypto and `TextEncoder`, reached through `globalThis`.
 *
 * The package compiles with `lib: ["ES2022"]` — deliberately no `DOM` — so these
 * globals are present at runtime in both Node ≥18 and Workers but carry no
 * ambient typings here. Narrow structural types beat widening the lib.
 */
type WebCryptoLike = {
  getRandomValues<T extends Uint8Array>(array: T): T;
  subtle: {
    digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
  };
};

type TextEncoderCtor = new () => { encode(input: string): Uint8Array };

const webGlobals = globalThis as unknown as {
  crypto: WebCryptoLike;
  TextEncoder: TextEncoderCtor;
};

/** Bytes of the anonymous bearer token. */
const ANON_TOKEN_BYTES = 32;

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded base64url of a byte array. Hand-rolled so no `btoa` global is needed. */
function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64URL_ALPHABET[b0 >> 2]!;
    out += BASE64URL_ALPHABET[((b0 & 0b11) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 === undefined) break;
    out += BASE64URL_ALPHABET[((b1 & 0b1111) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 === undefined) break;
    out += BASE64URL_ALPHABET[b2 & 0b111111]!;
  }
  return out;
}

/** Lowercase hex of a digest. */
function toHex(buffer: ArrayBuffer): string {
  let out = "";
  for (const byte of new Uint8Array(buffer)) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new webGlobals.TextEncoder().encode(input);
  return toHex(await webGlobals.crypto.subtle.digest("SHA-256", bytes));
}

/**
 * A fresh anonymous bearer token: 32 random bytes, base64url, CSPRNG.
 *
 * This single string grants replace and delete on a page with no other
 * authentication. It exists only in the claim/manage URL handed to the
 * publisher — it is never persisted (see `hashToken`) and never logged.
 */
export function generateAnonToken(): string {
  const bytes = webGlobals.crypto.getRandomValues(
    new Uint8Array(ANON_TOKEN_BYTES),
  );
  return base64UrlEncode(bytes);
}

/**
 * SHA-256 of an anon token, hex. What `sites.anon_token_hash` stores.
 *
 * Every lookup is an equality match on a digest, so there is no raw-token
 * comparison anywhere in the product and no constant-time helper to write.
 */
export function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}

/**
 * Salted SHA-256 of the publisher's client IP and user agent, hex.
 *
 * Feeds the dedup probe (unexpired anonymous draft, same content hash, same
 * publisher) and E07's rate limiter. Salted and hashed because storing visitor
 * IPs on a free-hosting product is a liability with no upside; the raw IP is
 * never returned and never logged. Rotating `PUBLISHER_HASH_SALT` invalidates
 * prior dedup matches, which is accepted.
 */
export function hashPublisher(
  ip: string,
  ua: string,
  salt: string,
): Promise<string> {
  return sha256Hex(`${salt}\n${ip}\n${ua}`);
}

/**
 * The `POST /api/publish` request body.
 *
 * **No `slug`.** The PRD rules a custom slug out at publish — "Slug: unique
 * readable ... auto"; choosing one is the rename path E06 owns. The
 * slug-bearing `publishPayloadSchema` in ./schemas is a different, unused-here
 * shape; see the note on it.
 */
export const publishRequestSchema = z.object({
  /** Raw HTML for the single page (v1 is single-file). Same validation as `publishPayloadSchema.html`. */
  html: pageHtmlSchema,
  /** Present only when the caller is the web UI; keyless API callers omit it and are governed by rate limits (E07). */
  turnstileToken: z.string().optional(),
  /** Optional address for the pre-expiry reminder (E05's cron). */
  reminderEmail: z.string().email().optional(),
});

export type PublishRequest = z.infer<typeof publishRequestSchema>;

/**
 * The `201` response body. Field names are the PRD's wire contract verbatim —
 * the snake/camel mix is intentional and must not be tidied, because agents and
 * E08 parse these exact keys.
 */
export const publishResponseSchema = z.object({
  /** `https://{slug}.kept.host` */
  live_url: z.string().url(),
  /** `https://kept.host/keep/{anonToken}` — the human-facing keep page. */
  claim_url: z.string().url(),
  slug: slugSchema,
  /** The raw bearer token. Returned once, stored only as a hash. */
  anonToken: z.string().min(1),
  /** Human-readable draft window, e.g. `"7d"`. */
  expires_in: z.string(),
  /** ISO 8601 instant the draft expires. */
  expires_at: z.string().datetime(),
  /** True when a content-hash match returned an existing draft instead of minting one. */
  deduped: z.boolean(),
});

export type PublishResponse = z.infer<typeof publishResponseSchema>;

/**
 * Machine-readable failure codes. Agents are the primary caller, so an
 * unparseable error is an infinite retry loop — codes are a closed enum, never
 * free-form strings.
 */
export const PUBLISH_ERROR_CODES = [
  /** Body was not parseable, or failed schema validation for a reason below. */
  "invalid_request",
  "empty_page",
  "page_too_large",
  /** Turnstile token was present but did not verify (web client only). */
  "turnstile_failed",
  /** Rate limited (E07). Carries `retry_after_seconds`. */
  "rate_limited",
  /** The heuristic content check rejected the page (E07). */
  "content_rejected",
  /** Slug minting exhausted its retry bound — transient, safe to retry. */
  "slug_unavailable",
  "internal_error",
] as const;

export const publishErrorCodeEnum = z.enum(PUBLISH_ERROR_CODES);
export type PublishErrorCode = (typeof PUBLISH_ERROR_CODES)[number];

/** The error body every non-2xx publish response carries. */
export const publishErrorSchema = z.object({
  error: publishErrorCodeEnum,
  /** Human-readable, specific, safe to show a visitor. */
  message: z.string(),
  /** Set on `rate_limited` so a caller can back off instead of hammering. */
  retry_after_seconds: z.number().int().nonnegative().optional(),
});

export type PublishError = z.infer<typeof publishErrorSchema>;
