import { request as apiRequest, type APIRequestContext } from "@playwright/test";

/**
 * A request context with **no shared cookie jar** and the local certificate
 * accepted — E05a task 007.
 *
 * TWO REASONS THIS IS NOT THE `request` FIXTURE, AND NOT `fetch`.
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
