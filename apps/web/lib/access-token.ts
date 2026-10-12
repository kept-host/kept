/**
 * Access tokens (E06a §2): the agent's way to publish while kept is closed.
 * `kpt_access_` + 32 random bytes, base64url; only the SHA-256 hex digest is
 * stored, in `KEPT_ACCESS_TOKEN_HASHES`.
 *
 * Apart from `lib/launch-access.ts` on purpose: this half imports no session
 * code, so the admin CLI (task 009) and the Playwright harness can mint a token
 * without loading Next's request-scoped modules.
 *
 * RETIRE: when kept opens or E08's API keys arrive.
 */
import { timingSafeEqual } from "node:crypto";

import { generateAnonToken, hashToken } from "@kept/shared";

import { accessTokenHashes } from "./storage/env";

/** Every access token starts with this, so a leaked one is recognisable. */
const ACCESS_TOKEN_PREFIX = "kpt_access_";

/** `Authorization: Bearer kpt_access_<32 random bytes, base64url>`. */
const ACCESS_TOKEN_BEARER = /^Bearer\s+(kpt_access_[A-Za-z0-9_-]{43})$/i;

/**
 * A new access token and the SHA-256 hex digest that goes into
 * `KEPT_ACCESS_TOKEN_HASHES`. Only the digest is ever stored; the token is shown
 * once and never logged.
 */
export async function mintAccessToken(): Promise<{ token: string; hash: string }> {
  const token = `${ACCESS_TOKEN_PREFIX}${generateAnonToken()}`;
  return { token, hash: await hashToken(token) };
}

/**
 * Whether the request's bearer is a configured access token. Every configured
 * digest is compared, in constant time, with no early exit — the answer is the
 * only thing a caller learns.
 */
export async function carriesAccessToken(request: Request): Promise<boolean> {
  const token = ACCESS_TOKEN_BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
  if (token === undefined) return false;

  const presented = Buffer.from(await hashToken(token), "utf8");
  let matched = false;
  for (const hash of accessTokenHashes()) {
    const expected = Buffer.from(hash, "utf8");
    if (expected.length === presented.length && timingSafeEqual(expected, presented)) {
      matched = true;
    }
  }
  return matched;
}
