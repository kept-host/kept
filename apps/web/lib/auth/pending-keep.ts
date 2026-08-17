/**
 * The pending-keep cookie — E05 task 009.
 *
 * ── WHAT IT CARRIES AND WHY IT IS A COOKIE ─────────────────────────────────
 * Keeping a page starts on `/keep/[anonToken]`, detours through GitHub, Google
 * or an email client, and has to come back with the bearer token still in hand.
 * The token grants replace and delete on somebody's page, and E04 spent real
 * effort keeping it out of `Referer` headers, search indexes and query strings
 * (`lib/publish/anon-token.ts`). Two shapes would carry it across the round trip
 * and both undo that:
 *
 *   - the OAuth `state` parameter — echoed back through the provider's redirect,
 *     so it lands in the provider's logs, in browser history and in the
 *     `Referer` of anything the callback page loads;
 *   - `/auth/keep?token=…`, the shape the PRD sketched — a bearer credential in
 *     a URL, i.e. in the address bar, in bookmarks and in every access log the
 *     request passes through.
 *
 * A cookie costs this one module and preserves E04's posture completely: the
 * token never appears in a URL a third party sees, and an abandoned sign-in
 * expires it instead of leaking it.
 *
 * ── `SameSite=Lax` IS THE WHOLE POINT, AND `Strict` WOULD BREAK IT ─────────
 * The hop this cookie exists for is the provider's redirect back to kept — a
 * **top-level GET navigation initiated by a third-party origin**. `Lax` sends
 * cookies on exactly that; `Strict` withholds them on any cross-site-initiated
 * navigation, including this one, so a `Strict` cookie would be present for the
 * magic-link path (same-site click in some clients, cross-site in others) and
 * silently absent for both OAuth providers. `Lax` is not a weakening here — it
 * is the only setting under which the flow works at all, and the intent it
 * carries is not a capability on its own: `/auth/callback` still requires a
 * session before it will keep anything.
 *
 * `httpOnly` so no script on any kept page can read a token the browser is
 * holding. `Path=/` because it is set on `/keep/[anonToken]` and read on
 * `/auth/callback`, which share no prefix. `Secure` everywhere except plain-HTTP
 * local dev, where the browser would drop it.
 *
 * ── SET ONCE, READ ONCE, AND ONLY ON THE LONG PATH ─────────────────────────
 * `app/keep/[anonToken]/start-keep.ts` writes it, and only when the visitor is
 * signed OUT — someone who already has a session takes no round trip, so they
 * take no cookie and the keep happens in the request that pressed the button.
 * `app/auth/callback/route.ts` is the only reader, and it deletes the cookie on
 * the same response as every one of its exits, before the keep is attempted. A
 * replay of that URL — a refresh, the back button, a link preloader — therefore
 * carries nothing and is a no-op.
 *
 * That reader is a **route handler and not a page**, which is not a style
 * choice: Next forbids mutating cookies during a Server Component render, and
 * the router renders a page more than once per navigation (a prefetch, then the
 * navigation), so a page would both be unable to spend the intent and liable to
 * spend it twice. See the header of `app/auth/callback/route.ts`.
 *
 * NO SERVER IMPORTS, deliberately, exactly as `./return-path.ts` explains: this
 * module is imported by a server action and by a route handler, and each uses
 * its own cookie API. This module owns the name, the lifetime, the attributes
 * and the shape guard, so the two cannot drift.
 */

/**
 * Namespaced so it cannot collide with Better Auth's own cookies, and named for
 * what it is rather than what it holds — the value never appears in a log line.
 */
export const PENDING_KEEP_COOKIE = "kept.pending_keep";

/**
 * Fifteen minutes. Long enough for the slowest leg of the round trip — a magic
 * link that has to arrive in an inbox, be found and be clicked — and short
 * enough that a visitor who wanders off does not leave a token sitting in their
 * browser for the rest of the day. Better Auth's own magic links last longer;
 * this is not that clock, it is the clock on *finishing the detour*.
 */
export const PENDING_KEEP_TTL_SECONDS = 15 * 60;

/** Where the round trip resumes. The only value ever written to `?next=`. */
export const KEEP_RESUME_PATH = "/auth/callback";

/**
 * Local dev serves plain HTTP, and a `Secure` cookie set over HTTP is discarded
 * by the browser — the intent would vanish between two same-origin requests and
 * look exactly like a bug in the flow.
 */
const secure = process.env.NODE_ENV !== "development";

/**
 * The cookie, ready to hand to `cookies().set()` or `NextResponse.cookies.set()`.
 * Both accept this object shape, so the attributes are stated once.
 */
export function pendingKeepCookie(token: string) {
  return {
    name: PENDING_KEEP_COOKIE,
    value: token,
    httpOnly: true,
    // See the header: `Strict` would drop this on the provider's redirect back,
    // which is the one hop the cookie exists for.
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: PENDING_KEEP_TTL_SECONDS,
  };
}

/**
 * The same cookie, expired. Emitted by `app/auth/callback/route.ts` on every one
 * of its exits, so a value that has been read once can never be read again.
 */
export function expiredPendingKeepCookie() {
  return {
    name: PENDING_KEEP_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: 0,
  };
}

/**
 * Is this string shaped like an anonymous token at all?
 *
 * The same structural test `resolveAnonToken` applies before touching Postgres —
 * 32 random bytes in unpadded base64url — restated here rather than imported so
 * this module keeps its "no server imports" property. It is a cheap reject, not
 * an authorisation: a well-shaped token that names nothing still resolves to the
 * one indistinguishable 404.
 */
export function isAnonTokenShaped(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(value);
}
