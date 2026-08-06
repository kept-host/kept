/**
 * The server-side session — E05 task 004.
 *
 * ONE module tells the rest of the control plane who is signed in. Server
 * components, server actions and route handlers all read a session through
 * `getSession()`; nothing else calls `auth.api.getSession` directly, so there is
 * exactly one place where "signed in" is defined and exactly one place to change
 * when it stops being a cookie.
 *
 * ── SERVER ONLY, AND NOT MERELY BY CONVENTION ──────────────────────────────
 * This module imports `next/headers`, which throws outside a request scope, so
 * a client component that imports it fails at build. That is the intended
 * enforcement of the rule: **a session lookup must never happen in a client
 * component, and must never happen anywhere near the serve path.** `apps/edge`
 * cannot import this file at all (it may only import `packages/shared`), and it
 * must not grow an equivalent: serving `*.kept.host` is 100% Cloudflare reading
 * R2 + KV, and a signed-out user, an expired session or a dead control plane
 * can never take a hosted page offline. If a change makes serving depend on
 * knowing who is asking, the change is wrong.
 *
 * ── TWO HELPERS, NOT THREE ─────────────────────────────────────────────────
 * `getSession()` answers, `requireSession()` answers or redirects. A route
 * handler that must reply 401 rather than redirect uses `getSession()` and
 * writes its own response — that is not a third variant, it is the handler
 * doing its own job. Adding a `requireSessionOrThrow` would put HTTP status
 * codes in this module, which is the API boundary's concern.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from ".";
import { APP_HOME, PATHNAME_HEADER, safeReturnPath, signInHref } from "./return-path";

/**
 * `{ session, user }`, or `null` when nobody is signed in. Derived from the
 * configured instance rather than restated, so a change to Better Auth's
 * session shape (task 003's config, a future plugin) is a type error here
 * instead of a silent divergence.
 */
export type AppSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

/**
 * Who is signed in, or `null`.
 *
 * Reads the request's cookies through `next/headers`, so it is valid in server
 * components, server actions and route handlers, and nowhere else.
 */
export async function getSession(): Promise<AppSession | null> {
  // `headers()` FIRST, and not as a style preference. It is the call that opts
  // the surrounding segment out of static rendering; reaching `auth.api` before
  // it would construct the instance — and validate all eight auth variables —
  // while `next build` is still collecting page data, turning a missing secret
  // into a failed build instead of a dynamic route.
  const requestHeaders = await headers();
  return auth.api.getSession({ headers: requestHeaders });
}

/**
 * The same read, but a signed-out visitor is sent to sign in and never sees the
 * page. Returns the session, so callers do not repeat the null check.
 *
 * THE RETURN URL IS THE POINT. Without it, every gated visit lands on the
 * landing page after signing in and the user has to find their way back —
 * which is also the mechanism task 009 leans on to resume a pending keep. The
 * path comes from `PATHNAME_HEADER` and is validated by `safeReturnPath`; a
 * caller may override it (`requireSession("/dashboard?tab=drafts")`) but cannot
 * bypass the validation. The pending-keep **token** is not carried here: it is
 * an httpOnly cookie, and putting a bearer credential in a query parameter
 * would undo E04's posture.
 *
 * `redirect()` throws, so nothing after it runs and the return type is honest.
 */
export async function requireSession(returnTo?: string): Promise<AppSession> {
  const session = await getSession();
  if (session) return session;

  const requested = returnTo ?? (await headers()).get(PATHNAME_HEADER) ?? APP_HOME;
  redirect(signInHref(safeReturnPath(requested)));
}
