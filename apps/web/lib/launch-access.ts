/**
 * The closed deploy's back door (E06a §1–2): who may create content while kept
 * is not open. Server-only — the token hashes and the session store are out of
 * the edge bundle's reach, so `middleware.ts` checks only that a credential is
 * PRESENT and every publish route calls `closedModeAccess` as its first action,
 * before its body is read (D6).
 *
 * RETIRE: when kept opens or E09's API keys arrive — this file,
 * `lib/access-token.ts`, its callers' two lines, and `KEPT_ACCESS_TOKEN_HASHES`.
 */
import type { Plan } from "@kept/shared";

import { carriesAccessToken } from "./access-token";
import { isAdminEmail } from "./auth/closed-sign-in";
import { sessionFor } from "./auth/session";
import { keptOpen } from "./launch";

/**
 * Which door admitted a request: `open` (kept is open — D9, everyone),
 * `token` (a valid access token) or `admin` (a `KEPT_ADMIN_EMAILS` session).
 */
export type AccessDoor = "open" | "token" | "admin";

/**
 * May this request create content, and through which door? Always `open` on an
 * open deploy (D9 — the token is then ignored). Closed: `token` or `admin`, else
 * `null`, so the callers that only ask "may it?" keep reading it as a boolean.
 * Reads no body, so a caller that answers `notOpenResponse()` on `null` has had
 * no side effect at all.
 */
export async function closedModeAccess(request: Request): Promise<AccessDoor | null> {
  if (keptOpen()) return "open";
  if (await carriesAccessToken(request)) return "token";

  const session = await sessionFor(request.headers);
  return session !== null && isAdminEmail(session.user.email) ? "admin" : null;
}

/**
 * The plan whose caps a KEYLESS publish or replace gets (E08 §5.3): `free`,
 * except a closed deploy's access-token or admin door — that is Arun and his
 * agent, measured against `premium`. Open, the token means nothing (D9).
 */
export function keylessPlan(door: AccessDoor): Plan {
  return door === "open" ? "free" : "premium";
}
