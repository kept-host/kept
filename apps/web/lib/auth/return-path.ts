/**
 * The return URL — where a gated visit resumes after signing in.
 *
 * ONE module owns the shape of `?next=`, because it is written in one place
 * (the `(app)` gate, below) and read in another (task 005's sign-in screen,
 * task 009's resumed keep). A validator that only runs on the write side is not
 * a validator: the parameter arrives from the address bar.
 *
 * ⚠️ AN UNVALIDATED RETURN URL IS A PHISHING PRIMITIVE. `/auth?next=https://
 * evil.example/login` turns kept's own sign-in page into an open redirect: the
 * victim clicks a kept link, signs in, and is handed to an attacker-controlled
 * page that looks like the one they just left. `safeReturnPath` therefore
 * accepts **same-origin, path-only** values and nothing else — no scheme, no
 * authority, no protocol-relative `//host`, no backslash variants — and falls
 * back to `APP_HOME` rather than throwing, because a malformed `next` is a
 * navigation detail and must never be the reason a sign-in fails.
 *
 * NO SERVER IMPORTS. This module is deliberately free of `next/headers` and
 * `next/navigation` so both the server gate and a client component can use it,
 * and so it is unit-testable with `tsx --test` (see `./return-path.test.ts`).
 * The **pending-keep token is not this** — it travels as an httpOnly cookie
 * (task 009) and must never appear in a query parameter.
 */

/** The sign-in route. Task 005 replaces its placeholder; the path is fixed. */
export const SIGN_IN_PATH = "/auth";

/** The query parameter carrying the return URL. */
export const RETURN_PARAM = "next";

/** Where a signed-in user lands with no return URL to resume. */
export const APP_HOME = "/dashboard";

/**
 * The header `middleware.ts` stamps with the requested path, and the only way
 * the `(app)` gate can learn which path it is rendering for — Next exposes the
 * request path to a server component nowhere else (verified: a document request
 * carries `host` and the `x-forwarded-*` set, nothing more).
 *
 * Untrusted like every other request header — a client can send it — which is
 * why its value only ever reaches `safeReturnPath`, never a raw redirect. It
 * lives here rather than in `./session.ts` so `middleware.ts` can import the
 * name without dragging the auth instance (and `postgres-js`) into the edge
 * bundle.
 */
export const PATHNAME_HEADER = "x-kept-pathname";

/** Longer than any route this app has; a `next` past it is not a real path. */
const MAX_RETURN_PATH_LENGTH = 512;

/**
 * A base whose origin exists nowhere and can never be reached, so a value that
 * carries its own origin (`https://evil.example/…`, `//evil.example/…`) parses
 * to something *other* than this and is rejected by the comparison below.
 */
const RESOLUTION_BASE = "https://return-path.invalid";

/**
 * The validated return path, or `APP_HOME`.
 *
 * Accepts `/dashboard`, `/dashboard?tab=drafts`. Rejects (to `APP_HOME`) an
 * absolute URL, a protocol-relative `//host/path`, a backslash-authority
 * `/\host`, anything not starting with `/`, control characters, and anything
 * over `MAX_RETURN_PATH_LENGTH`. The fragment is dropped: the server never
 * receives one, so keeping it would only widen what the parameter can carry.
 */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string") return APP_HOME;

  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > MAX_RETURN_PATH_LENGTH) return APP_HOME;

  // A path, not a URL. `//host` and `/\host` are both authorities to a browser.
  if (!candidate.startsWith("/")) return APP_HOME;
  if (candidate.startsWith("//")) return APP_HOME;
  // A backslash is a path separator to the WHATWG URL parser (`/\host` resolves
  // to `//host`), and tabs/newlines are stripped before parsing — both let a
  // rejected shape smuggle itself past a naive prefix test.
  if (/[\\\u0000-\u001f\u007f]/.test(candidate)) return APP_HOME;

  let resolved: URL;
  try {
    resolved = new URL(candidate, RESOLUTION_BASE);
  } catch {
    return APP_HOME;
  }
  if (resolved.origin !== RESOLUTION_BASE) return APP_HOME;

  return `${resolved.pathname}${resolved.search}`;
}

/**
 * The sign-in URL a gated visit is sent to, carrying where to resume.
 * `returnTo` is validated here so no caller can construct an unsafe one.
 */
export function signInHref(returnTo?: unknown): string {
  const target = safeReturnPath(returnTo);
  return `${SIGN_IN_PATH}?${RETURN_PARAM}=${encodeURIComponent(target)}`;
}
