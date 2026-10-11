/**
 * The session cookie's name — one constant, because two places read it.
 *
 * `lib/auth/index.ts` configures Better Auth with it (the block comment there
 * says why it is `__Host-` and why the automatic prefix is suppressed), and
 * `middleware.ts` checks for its PRESENCE on a closed deploy's publish routes
 * (`decideClosedAction`). Its own module so the edge bundle can import it
 * without pulling in the auth instance.
 */
export const SESSION_COOKIE_NAME = "__Host-kept.session_token";
