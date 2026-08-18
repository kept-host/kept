/**
 * The origin gate for cookie-authenticated mutating routes — E05a task 006.
 *
 * ── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────
 * `{slug}.kept-dev.xyz` and `app.kept-dev.xyz` share a registrable domain, and
 * dev can never be PSL-listed, so a hosted page calling the control plane is
 * *same-site*. `SameSite=Lax` therefore does not block it and the session
 * cookie rides along. `__Host-` (task 005) stops cookie *tossing*; it does
 * nothing about CSRF. This check is what closes that gap, and it is the second
 * half of epic decision D3.
 *
 * ── THE RULE BINDS TO COOKIE USE, NOT TO HTTP METHOD ───────────────────────
 * CSRF is an ambient-authority attack: it works because the browser attaches a
 * credential the attacker's page does not possess and cannot read. A route that
 * authenticates with the **session cookie** has that ambient authority and calls
 * this. A route that authenticates with the `anonToken` in its **path** does
 * not — an attacker who has the token can call the API from anywhere, so an
 * `Origin` header proves nothing there, while requiring one would break every
 * keyless agent call E08 is built on and every `curl` in the README. Those four
 * bearer-only routes (`POST /api/publish`, `DELETE|POST /api/anon/:token…`)
 * deliberately do NOT import this module, and `origin.test.ts` asserts it.
 *
 * ── DECISIONS, AND WHERE THEY DIVERGE FROM BETTER AUTH ─────────────────────
 * All three were taken against the installed better-auth@1.6.26
 * (`dist/api/middlewares/origin-check.mjs`, `validateOrigin`), read rather than
 * remembered, because one app must not answer one request shape two ways.
 *
 * 1. NO COOKIE → NO CHECK. Better Auth gates its own check on
 *    `const useCookies = headers.has("cookie")`. Mirrored exactly. A request
 *    with no cookie carries no ambient authority; it gets the 401 the handler
 *    would have given it anyway, and a keyless client is never asked for a
 *    header it has no reason to send.
 * 2. ORIGIN ABSENT **AND** `Sec-Fetch-Site` ABSENT, COOKIE PRESENT → 403.
 *    Matches Better Auth, which throws `MISSING_OR_NULL_ORIGIN` for exactly
 *    that shape (origin header absent or the literal `"null"`). No real client
 *    is refused by it: browsers always send `Origin` on a POST — the Fetch
 *    spec requires it for any request whose method is not GET/HEAD, regardless
 *    of cross-origin-ness — and every browser that has shipped since 2020 also
 *    sends `Sec-Fetch-Site`. A non-browser client that sends the session cookie
 *    and neither header does not exist: the cookie is `__Host-`, httpOnly, and
 *    only ever minted into a browser jar. None could be named, so the branch
 *    refuses, per the task's instruction to default to Better Auth's answer.
 * 3. THE FALLBACK IS `Sec-Fetch-Site`, NOT `Referer` — the one deliberate
 *    divergence. Better Auth falls back `Origin` → `Referer`. `Referer` is
 *    suppressible by referrer policy and by any `<meta name="referrer">` on the
 *    attacker's own page, so treating its *absence* as unremarkable and its
 *    *presence* as authority gives an attacker a lever. `Sec-Fetch-Site` is a
 *    forbidden header name: script cannot set it, and the browser computes it
 *    from the true initiator. Only `same-origin` passes — `same-site` is
 *    refused ON PURPOSE, because a hosted page at `{slug}.kept-dev.xyz` is
 *    precisely the `same-site` case that `SameSite` fails to block. The shape
 *    the two rules disagree on (cookie + no `Origin` + a `Referer` + no
 *    `Sec-Fetch-Site`) is not producible by a browser that sends `Referer`.
 *
 * The comparison is on scheme + host + port via `URL`, never a prefix or suffix
 * test, so `https://app.kept-dev.xyz.evil.com` fails. The trusted value is
 * `authConfig().baseUrl` — the same pinned origin task 005 put in Better Auth's
 * `trustedOrigins`, so the two cannot drift — never a hostname literal and
 * never a second `process.env` read of this module's own.
 */
import type { NextResponse } from "next/server";

import { authConfig } from "../storage/env";

import { errorResponse } from "./http";

/**
 * The refusal. 403, and the publish family's closed `{ error, message }` shape
 * through `errorResponse` — `invalid_request` for the reason `lib/sites/
 * owner-routes.ts` states: `PUBLISH_ERROR_CODES` is a closed enum shared with
 * `apps/edge`'s consumers, the *status* carries the distinction a caller acts
 * on, and a code minted per call site is how a closed enum stops being closed.
 */
function refusal(appOrigin: string): NextResponse {
  return errorResponse(403, {
    error: "invalid_request",
    message:
      `This request did not come from ${appOrigin}. Pages are managed from the ` +
      `kept app itself; a request made from another site is refused even when ` +
      `it carries a valid session.`,
  });
}

/** Exact origin equality — scheme, host and port — or `false` if unparseable. */
function isAppOrigin(candidate: string, appOrigin: string): boolean {
  try {
    return new URL(candidate).origin === new URL(appOrigin).origin;
  } catch {
    // Includes the literal `"null"` opaque origin, which Better Auth also
    // refuses outright: a sandboxed iframe or a redirected cross-origin POST.
    return false;
  }
}

/**
 * `null` when the request may proceed, a ready-to-return 403 when it may not.
 *
 * Call it FIRST in the handler — before the session lookup, before the body
 * read, before any store or database call — so a refused request mutates
 * nothing, costs one string comparison, and cannot be timed into an oracle.
 */
export function refuseUntrustedOrigin(request: Request): NextResponse | null {
  // Decision 1: the check binds to cookie use, mirroring Better Auth.
  if (!request.headers.has("cookie")) return null;

  const { baseUrl } = authConfig();
  const origin = request.headers.get("origin");

  if (origin) return isAppOrigin(origin, baseUrl) ? null : refusal(baseUrl);

  // Decision 3: `Sec-Fetch-Site`, and only `same-origin`.
  return request.headers.get("sec-fetch-site") === "same-origin"
    ? null
    : refusal(baseUrl);
}
