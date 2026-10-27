// @kept/shared — the agent contract (E09): API keys, the `X-Kept-Client`
// header, agent sign-in by emailed code, the agent rate limits and the keyed
// REST (`/api/v1/*`) shapes. Frozen here once so the pipelines, `/api/keys`,
// `/api/agent/*`, `/api/v1/*`, the MCP server and the skill read one source.
// Provenance (D10) lives in ./provenance (see the note there).
//
// MCP naming (Q2): the MCP tools return the keyless page token as
// `manage_token` — the same value `POST /api/publish` returns as `anonToken`,
// which stays frozen. `publish.sh --replace <manage_token>` documents the map.
//
// Isomorphic like ./publish: the Worker bundles the barrel, so Web Crypto only.

import { z } from "zod";

import { PAGE_TITLE_MAX_LENGTH } from "./constants";
import { PROVENANCE_LIMITS } from "./provenance";
import { PUBLISH_ERROR_CODES, base64UrlEncode, hashToken } from "./publish";
import { slugSchema } from "./schemas";
import { waitlistEmailSchema, type RateLimitRule } from "./waitlist";
import { webGlobals } from "./web-globals";

// --- API keys (D6, D-18) -----------------------------------------------------

export const API_KEY_PREFIX = "kpt_live_";

/** Random bytes behind the prefix; base64url, so 43 characters. */
export const API_KEY_RANDOM_BYTES = 32;

/** A well-formed key: the prefix and 43 base64url characters. */
export const apiKeyPattern = /^kpt_live_[A-Za-z0-9_-]{43}$/;

/** Characters of a key shown in Settings and stored as `api_keys.prefix` — `kpt_live_` + 4. */
export const API_KEY_DISPLAY_PREFIX_CHARS = 13;

/** Live keys one account may hold (Q-PRD-1). */
export const API_KEYS_PER_ACCOUNT = 25;

/** What Settings shows and `POST /api/keys` answers at the cap (PRD §8). */
export const API_KEY_LIMIT_MESSAGE = `You have ${API_KEYS_PER_ACCOUNT} keys. Revoke one to create another.`;

/** A key's label, as the human or `keyName` gives it. */
export const apiKeyNameSchema = z.string().trim().min(1).max(60);

/** A fresh key. Shown once to its owner, stored only as `hashApiKey`'s digest, never logged. */
export function generateApiKey(): string {
  const bytes = webGlobals.crypto.getRandomValues(new Uint8Array(API_KEY_RANDOM_BYTES));
  return API_KEY_PREFIX + base64UrlEncode(bytes);
}

/** SHA-256 of a key, hex — `api_keys.hash`. The anon token's digest; an equality lookup, no raw compare. */
export function hashApiKey(key: string): Promise<string> {
  return hashToken(key);
}

// --- X-Kept-Client (D9) ------------------------------------------------------

export const KEPT_CLIENT_HEADER = "x-kept-client";

/** Longest `site_versions.client`. */
export const KEPT_CLIENT_MAX = 40;

const KEPT_CLIENT_PATTERN = new RegExp(`^[a-z0-9._/-]{1,${KEPT_CLIENT_MAX}}$`);

/**
 * The header's value if it is a valid client label (`codex/skill`,
 * `claude-code/mcp`), else null. Nothing is lowercased or trimmed, and an
 * invalid value is only ever dropped — never a refusal (AC10). It is an
 * aggregate-count label, never used as a path.
 */
export function parseKeptClient(raw: string | null): string | null {
  return raw !== null && KEPT_CLIENT_PATTERN.test(raw) ? raw : null;
}

// --- Rate limits -------------------------------------------------------------

const HOUR_SECONDS = 60 * 60;

/** E09's buckets, beside E07's `PUBLISH_RATE_LIMITS`. Over any of them: 429 `rate_limited`. */
export const AGENT_RATE_LIMITS = {
  /** `key:<keyId>` — keyed publishes and replaces per key per hour (D6). */
  perKeyHour: { limit: 120, windowSeconds: HOUR_SECONDS },
  /** `mcp-session:<sessionHash>` — keyless MCP publishes per session per hour (D5). */
  mcpSessionHour: { limit: 20, windowSeconds: HOUR_SECONDS },
  /** `mcp-ip:<ipHash>` — keyless MCP publishes per shared egress IP per hour (Q6). */
  mcpPerIpHour: { limit: 300, windowSeconds: HOUR_SECONDS },
  /** `POST /api/agent/request-code` per IP (D7). */
  agentCodePerIp: { limit: 5, windowSeconds: HOUR_SECONDS },
  /** `POST /api/agent/request-code` per address (D7). */
  agentCodePerEmail: { limit: 3, windowSeconds: HOUR_SECONDS },
} as const satisfies Record<string, RateLimitRule>;

// --- Agent sign-in by emailed code (D7) --------------------------------------

export const AGENT_CODE_DIGITS = 6;
export const AGENT_CODE_TTL_MINUTES = 10;
/** Wrong guesses before a code is spent. */
export const AGENT_CODE_MAX_ATTEMPTS = 5;

/** `POST /api/agent/request-code`. */
export const agentCodeRequestSchema = z.object({ email: waitlistEmailSchema });

export type AgentCodeRequest = z.infer<typeof agentCodeRequestSchema>;

/** `POST /api/agent/verify-code`. */
export const agentCodeVerifySchema = z.object({
  email: waitlistEmailSchema,
  code: z.string().trim().regex(new RegExp(`^\\d{${AGENT_CODE_DIGITS}}$`)),
  keyName: apiKeyNameSchema,
});

export type AgentCodeVerify = z.infer<typeof agentCodeVerifySchema>;

/** `verify-code`'s answer: the new key, once. */
export const agentCodeVerifyResponseSchema = z.object({
  api_key: z.string().regex(apiKeyPattern),
  key_name: apiKeyNameSchema,
});

export type AgentCodeVerifyResponse = z.infer<typeof agentCodeVerifyResponseSchema>;

// --- Keyed REST (D8): /api/v1/pages, /api/keys --------------------------------

/**
 * `POST /api/v1/pages` and `PUT /api/v1/pages/{slug}`: the page belongs to the
 * key's account and lands kept if a slot is free, else a draft — no claim link.
 */
export const keyedPublishResponseSchema = z.object({
  live_url: z.string().url(),
  studio_url: z.string().url(),
  slug: slugSchema,
  kept: z.boolean(),
  /** Null for a kept page; the draft's expiry otherwise. */
  expires_at: z.string().datetime().nullable(),
});

export type KeyedPublishResponse = z.infer<typeof keyedPublishResponseSchema>;

/** A stored provenance text field on the way out: null when never given. */
function storedText(max: number) {
  return z.string().max(max).nullable();
}

/** `GET /api/v1/pages/{slug}`, and one row of the list. */
export const keyedPageSchema = keyedPublishResponseSchema.extend({
  title: storedText(PAGE_TITLE_MAX_LENGTH),
  model: storedText(PROVENANCE_LIMITS.model),
  tool: storedText(PROVENANCE_LIMITS.tool),
  prompt: storedText(PROVENANCE_LIMITS.prompt),
  readme: storedText(PROVENANCE_LIMITS.readme),
  source_url: storedText(PROVENANCE_LIMITS.source_url),
  /** The remixed page's slug, when it is stored (kept and live at publish). */
  remix_of: slugSchema.nullable(),
  file_count: z.number().int().positive(),
  updated_at: z.string().datetime(),
});

export type KeyedPage = z.infer<typeof keyedPageSchema>;

/** `GET /api/v1/pages`: newest first; pass `next_cursor` back as `?cursor=` until it is null. */
export const keyedListResponseSchema = z.object({
  pages: z.array(keyedPageSchema),
  next_cursor: z.string().nullable(),
});

export type KeyedListResponse = z.infer<typeof keyedListResponseSchema>;

/** One key in `GET /api/keys` — never the key or its hash. */
export const apiKeySummarySchema = z.object({
  id: z.string().uuid(),
  name: apiKeyNameSchema,
  prefix: z.string().length(API_KEY_DISPLAY_PREFIX_CHARS),
  created_at: z.string().datetime(),
  /** UTC date only (`YYYY-MM-DD`), no time — Risk 6. */
  last_used_on: z.string().date().nullable(),
});

export type ApiKeySummary = z.infer<typeof apiKeySummarySchema>;

/** `POST /api/keys`: the summary plus the key itself, shown this once. */
export const apiKeyCreatedSchema = apiKeySummarySchema.extend({
  api_key: z.string().regex(apiKeyPattern),
});

export type ApiKeyCreated = z.infer<typeof apiKeyCreatedSchema>;

/**
 * `/api/v1/*`'s closed code enum (Q10): the keyless codes plus four of its
 * own, in the same flat body, so an agent parses one shape on either door.
 */
export const KEYED_ERROR_CODES = [
  ...PUBLISH_ERROR_CODES,
  /** No key, a malformed key, or a revoked one. 401. */
  "unauthorized",
  /** No such page on this key's account. 404. */
  "not_found",
  /** `API_KEYS_PER_ACCOUNT` live keys already (`/api/agent/verify-code`). 409. */
  "key_limit_reached",
  /** `/api/agent/verify-code`: a wrong, expired, spent or never-sent code — one answer for all four. 400. */
  "invalid_code",
] as const;

export const keyedErrorCodeEnum = z.enum(KEYED_ERROR_CODES);
export type KeyedErrorCode = (typeof KEYED_ERROR_CODES)[number];

/** The flat error body every non-2xx `/api/v1/*` response carries — `publishErrorSchema`'s shape. */
export const keyedErrorSchema = z.object({
  error: keyedErrorCodeEnum,
  message: z.string(),
  retry_after_seconds: z.number().int().nonnegative().optional(),
});

export type KeyedError = z.infer<typeof keyedErrorSchema>;
