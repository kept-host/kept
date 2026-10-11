/**
 * Who may sign in, and how often a magic link may be asked for — E06a §2, §5.
 *
 * While kept is closed (`keptOpen()` false) only `KEPT_ADMIN_EMAILS` can hold a
 * session (D7). The refusal lives inside Better Auth, in the `user` and
 * `session` `create.before` hooks (`./index.ts`), so every door — GitHub,
 * Google, magic link, and any door added later — is covered by the same two
 * checks. Open, both checks are no-ops (D9).
 *
 * ── HOW `not_open` REACHES `/auth` (verified against better-auth 1.6.26) ────
 * The hooks THROW an `APIError` whose body is `{ code: "not_open", message:
 * "not_open" }` rather than returning `false`; `false` only ever surfaces as a
 * generic failure.
 *   - OAuth, new user: `handleOAuthUserInfo` catches the throw from
 *     `createOAuthUser` (its transaction rolls back — no `user`, no `account`)
 *     and returns `{ error: e.message }`, which the callback redirects to the
 *     error URL as `?error=not_open`. That is why the message is the code.
 *   - OAuth, existing user: `createSession` throws outside that catch; the
 *     callback's own catch redirects `?error=<body.code>` = `not_open`.
 *   - Magic-link verify: nothing catches it, so the endpoint answers a JSON
 *     403 `not_open` — no session, no cookie. Reachable only through a link
 *     minted before the deploy closed or before the address left the
 *     allowlist, because a closed deploy never mails a non-admin a link.
 *
 * ── `session.create.before` GETS A `userId`, NOT AN EMAIL ───────────────────
 * One indexed read per sign-in, closed only. It runs after `createOAuthUser`'s
 * transaction has committed, so a first-time admin's row is visible to it.
 */
import { RATE_LIMITS } from "@kept/shared";
import { APIError } from "better-auth/api";

import { userEmail } from "../db/queries/account";
import { keptOpen } from "../launch";
import { adminEmails } from "../storage/env";

export const NOT_OPEN = "not_open";

/** Whether `email` is in `KEPT_ADMIN_EMAILS` (compared trimmed and lowercased). */
export function isAdminEmail(email: string): boolean {
  return adminEmails().has(email.trim().toLowerCase());
}

/** May this address hold a session on this deploy? Always when open (D9). */
export function maySignIn(email: string): boolean {
  return keptOpen() || isAdminEmail(email);
}

function notOpen(): APIError {
  return new APIError("FORBIDDEN", { code: NOT_OPEN, message: NOT_OPEN });
}

/** `databaseHooks.user.create.before`: refuse a closed-mode non-admin. */
export function refuseUserUnlessMaySignIn(email: string): void {
  if (!maySignIn(email)) throw notOpen();
}

/**
 * `databaseHooks.session.create.before`: the same rule for a user who already
 * exists, resolved from the `user` row. A user id with no row is refused.
 */
export async function refuseSessionUnlessMaySignIn(userId: string): Promise<void> {
  if (keptOpen()) return;
  const email = await userEmail(userId);
  if (email === null || !isAdminEmail(email)) throw notOpen();
}

/**
 * PRD §5's magic-link limits — 5 an hour per IP, 3 an hour per address — on
 * `lib/rate-limit`, in both modes. Throws a 429 `APIError` carrying
 * `Retry-After`; Better Auth's own in-memory plugin limiter stays as it is.
 * Both buckets are counted on every request, so one cannot be drained to dodge
 * the other. A call with no request (a server-side `auth.api` call) has no IP
 * and is limited per address only.
 */
export async function limitMagicLink(email: string, request: Request | undefined): Promise<void> {
  // Imported on use: `lib/rate-limit` reaches `next/server` (through
  // `clientIp`), and the e2e specs import `lib/auth` under Playwright's plain
  // Node loader, which cannot resolve that bare specifier.
  const { clientIp, emailKey, hit, ipKey } = await import("../rate-limit");
  const checks = [hit(await emailKey("magic-link", email.trim().toLowerCase()), RATE_LIMITS.magicLinkPerEmail)];
  if (request) {
    checks.push(hit(await ipKey("magic-link", clientIp(request)), RATE_LIMITS.magicLinkPerIp));
  }
  const refused = (await Promise.all(checks)).flatMap((result) =>
    result.allowed ? [] : [result.retryAfterSeconds],
  );
  if (refused.length === 0) return;

  throw new APIError(
    "TOO_MANY_REQUESTS",
    { code: "too_many_requests", message: "Too many sign-in links requested. Try again later." },
    { "Retry-After": String(Math.max(...refused)) },
  );
}
