import { request as apiRequest, type APIRequestContext } from "@playwright/test";

/**
 * How the API specs make a request that a **real browser** would have made —
 * E05a task 007.
 *
 * Two things a browser does for free that an `APIRequestContext` does not, and
 * both bit this suite when D5 moved the harness to https.
 */

/**
 * A request context with **no shared cookie jar** and the local certificate
 * accepted.
 *
 * NOT the `request` fixture, and not `fetch`:
 *
 * 1. **No jar.** The specs that use this mint a real session cookie and then
 *    pass it by hand, sometimes for two different users inside one test. The
 *    `request` fixture keeps a cookie jar for the whole test, so a session
 *    minted through it would be sent automatically on every later call —
 *    silently signing in the requests that exist to prove a signed-out 401, and
 *    clobbering the second user with the first. A context created here is
 *    disposed by its caller and shares nothing.
 * 2. **https.** These calls used Node's global `fetch`, which has no
 *    equivalent of `ignoreHTTPSErrors`. Since the harness moved to
 *    `https://localhost:3000` (D5 — the session cookie is `__Host-`, therefore
 *    `Secure`, therefore not stored over plain http) every such call failed
 *    with `self-signed certificate in certificate chain`. `use.ignoreHTTPSErrors`
 *    in `playwright.config.ts` covers the `page` and `request` fixtures and
 *    cannot reach `fetch`, so the flag is passed explicitly here.
 *
 * Always `await ctx.dispose()` in a `finally` — an undisposed context leaks a
 * connection for the life of the worker.
 */
export function jarlessContext(): Promise<APIRequestContext> {
  return apiRequest.newContext({ ignoreHTTPSErrors: true });
}

/**
 * The headers a browser sends on a cookie-bearing mutating request: the session
 * cookie **and** `Origin`.
 *
 * `lib/publish/origin.ts` (task 006) refuses a request that carries a cookie
 * and neither `Origin` nor `Sec-Fetch-Site: same-origin` — the shape Better
 * Auth calls `MISSING_OR_NULL_ORIGIN`. That is correct: the Fetch spec requires
 * a browser to send `Origin` on every request whose method is not GET or HEAD,
 * cross-origin or not, and `Sec-Fetch-Site` is a forbidden header name the
 * browser computes itself. An `APIRequestContext` sends neither, so a spec that
 * omits `Origin` is modelling a client that does not exist and gets a 403 that
 * says nothing about what it meant to assert.
 *
 * This does NOT loosen the check — it is the caller becoming honest about being
 * a browser. `auth-providers.spec.ts` already does the same thing by hand for
 * Better Auth's own copy of the rule. The refusal path (a cookie plus a
 * `{slug}` origin → 403, mutating nothing) is covered directly by
 * `lib/publish/origin.test.ts` and lands on the wire in task 008.
 */
export function sessionHeaders(cookie: string, baseURL: string): Record<string, string> {
  return { cookie, origin: new URL(baseURL).origin };
}
