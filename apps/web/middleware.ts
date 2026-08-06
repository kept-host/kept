/**
 * Stamps the requested path onto the request headers. That is the whole file.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Next.js gives a server component no way to learn the path it is rendering
 * for: `headers()` on a document request carries `host` and the `x-forwarded-*`
 * set and nothing else (verified, not assumed). The `(app)` gate needs it, and
 * only for one purpose — to put `?next=/dashboard` on the sign-in redirect so a
 * gated visit resumes where it left off instead of dumping the user on the
 * landing page after signing in.
 *
 * ── WHAT THIS DELIBERATELY IS NOT ──────────────────────────────────────────
 * **It is not the auth gate, and it must never become one.** Middleware runs on
 * the edge runtime, which cannot open a Postgres connection, so a session check
 * here would need either a second JWT-shaped source of truth or a fetch back
 * into the app — two mechanisms to keep in sync where the RSC tree already has
 * one. The gate is `app/(app)/layout.tsx`, reading the same session every other
 * server component reads. This file performs no session lookup, no database
 * access and no redirect; if a future change adds one, it belongs in the layout.
 *
 * The header is untrusted like any other — a client can send `x-kept-pathname`
 * itself — and `.set()` below overwrites whatever arrived. Even so, the value is
 * only ever consumed through `safeReturnPath`, so a forged one can at worst
 * choose a same-origin path the visitor was already free to request.
 */
import { NextResponse, type NextRequest } from "next/server";

import { PATHNAME_HEADER } from "@/lib/auth/return-path";

export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(
    PATHNAME_HEADER,
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );
  return NextResponse.next({ request: { headers } });
}

export const config = {
  /**
   * Everything except Next's own assets and the API surface. Broad on purpose:
   * a matcher listing the gated routes would be a second place to remember a
   * new `(app)/*` route, and forgetting it would silently lose the return URL.
   * `/api/*` is excluded because no route handler reads the header — they parse
   * their own request — and the auth endpoints in particular should carry
   * nothing extra.
   */
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.[^/]+$).*)"],
};
