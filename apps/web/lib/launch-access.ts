/**
 * The closed deploy's back door (E06a §1–2): who may create content while kept
 * is not open. Server-only — the token hashes and the session store are out of
 * the edge bundle's reach, so `middleware.ts` checks only that a credential is
 * PRESENT and every publish route calls `closedModeAccess` as its first action,
 * before its body is read (D6).
 *
 * E09 (Q9) added the `key` door beside the access token: an API key owned by a
 * `KEPT_ADMIN_EMAILS` account. The token stays until launch.
 *
 * RETIRE: at launch (E14), when kept opens — this file's token door,
 * `lib/access-token.ts`, its callers' two lines, and `KEPT_ACCESS_TOKEN_HASHES`.
 * The `key` door goes with the closed gate itself.
 */
import type { Plan } from "@kept/shared";

import { carriesAccessToken } from "./access-token";
import { keyCallerFrom } from "./agents/keys";
import { isAdminEmail } from "./auth/closed-sign-in";
import { sessionFor } from "./auth/session";
import { userEmail } from "./db/queries/account";
import { keptOpen } from "./launch";

/**
 * Which door admitted a request: `open` (kept is open — D9, everyone),
 * `token` (a valid access token), `key` (an API key whose account is a
 * `KEPT_ADMIN_EMAILS` address — E09) or `admin` (a `KEPT_ADMIN_EMAILS` session).
 */
export type AccessDoor = "open" | "token" | "key" | "admin";

/**
 * May this request create content, and through which door? Always `open` on an
 * open deploy (D9 — the token is then ignored). Closed: `token`, `key` or `admin`, else
 * `null`, so the callers that only ask "may it?" keep reading it as a boolean.
 * Reads no body, so a caller that answers `notOpenResponse()` on `null` has had
 * no side effect at all.
 */
export async function closedModeAccess(request: Request): Promise<AccessDoor | null> {
  if (keptOpen()) return "open";
  if (await carriesAccessToken(request)) return "token";

  const key = await keyCallerFrom(request);
  if (key !== null) {
    const owner = await userEmail(key.profileId);
    if (owner !== null && isAdminEmail(owner)) return "key";
  }

  const session = await sessionFor(request.headers);
  return session !== null && isAdminEmail(session.user.email) ? "admin" : null;
}

/**
 * The plan whose caps a KEYLESS publish or replace gets (E08 §5.3): `free`,
 * except a closed deploy's access-token or admin door — that is Arun and his
 * agent, measured against `premium` (so is a keyless call through the `key`
 * door; a KEYED publish takes its owner's plan instead, Q15). Open, the token
 * means nothing (D9).
 */
export function keylessPlan(door: AccessDoor): Plan {
  return door === "open" ? "free" : "premium";
}
