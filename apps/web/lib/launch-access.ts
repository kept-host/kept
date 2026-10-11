/**
 * The closed deploy's back door (E06a §1–2): who may create content while kept
 * is not open. Server-only — the token hashes and the session store are out of
 * the edge bundle's reach, so `middleware.ts` checks only that a credential is
 * PRESENT and every publish route calls `closedModeAccess` as its first action,
 * before its body is read (D6).
 *
 * RETIRE: when kept opens or E08's API keys arrive — this file,
 * `lib/access-token.ts`, its callers' two lines, and `KEPT_ACCESS_TOKEN_HASHES`.
 */
import { carriesAccessToken } from "./access-token";
import { sessionFor } from "./auth/session";
import { keptOpen } from "./launch";
import { adminEmails } from "./storage/env";

/** Whether `email` is in `KEPT_ADMIN_EMAILS` (compared trimmed and lowercased). */
export function isAdminEmail(email: string): boolean {
  return adminEmails().has(email.trim().toLowerCase());
}

/**
 * May this request create content? Always on an open deploy (D9). Closed: only
 * with a valid access token or the session of a `KEPT_ADMIN_EMAILS` user.
 * Reads no body, so a caller that answers `notOpenResponse()` on `false` has had
 * no side effect at all.
 */
export async function closedModeAccess(request: Request): Promise<boolean> {
  if (keptOpen()) return true;
  if (await carriesAccessToken(request)) return true;

  const session = await sessionFor(request.headers);
  return session !== null && isAdminEmail(session.user.email);
}
