/**
 * Two jobs, both decided from the request line alone.
 *
 * 1. **The apex / `app.` split** (E05a, D2 + D6) — the apex serves the landing,
 *    the `app.` host serves the control plane, and both attach to the *same*
 *    Railway service. Middleware is the only code that sees the `Host` before
 *    routing, so the split lives here. The rule itself is `decideHostAction` in
 *    `lib/routing/host-split.ts`, kept pure so its cases are unit-testable
 *    without a request scope; this file is the wrapper that applies it. On a
 *    deploy that is not yet open (`lib/launch.ts`), `decideClosedAction` runs
 *    first and narrows publishing and sign-in to the admins (E06a §1).
 * 2. **Stamping the requested path** onto the request headers, for the `(app)`
 *    gate. Next.js gives a server component no way to learn the path it is
 *    rendering for: `headers()` on a document request carries `host` and the
 *    `x-forwarded-*` set and nothing else (verified, not assumed). The gate
 *    needs it for one purpose — to put `?next=/dashboard` on the sign-in
 *    redirect so a gated visit resumes where it left off instead of dumping the
 *    user on the landing page after signing in.
 *
 * ── WHAT THIS DELIBERATELY IS NOT ──────────────────────────────────────────
 * **It is not the auth gate, and it must never become one.** The redirect above
 * is host-based: it needs no session, no database and no fetch, which is what
 * lets it run on the edge runtime at all. Middleware cannot open a Postgres
 * connection, so a session check here would need either a second JWT-shaped
 * source of truth or a fetch back into the app — two mechanisms to keep in sync
 * where the RSC tree already has one. The gate is `app/(app)/layout.tsx`,
 * reading the same session every other server component reads. Signing out, an
 * apex `/dashboard` therefore takes two hops by design: 307 to `app.`, then the
 * gate's own redirect to `/auth?next=/dashboard`. This file performs no session
 * lookup and no database access; if a future change adds one, it belongs in the
 * layout.
 *
 * The header is untrusted like any other — a client can send `x-kept-pathname`
 * itself — and `.set()` below overwrites whatever arrived. Even so, the value is
 * only ever consumed through `safeReturnPath`, so a forged one can at worst
 * choose a same-origin path the visitor was already free to request.
 */
import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE_NAME } from "@/lib/auth/cookie";
import { PATHNAME_HEADER } from "@/lib/auth/return-path";
import { keptOpen, notOpenResponse } from "@/lib/launch";
import { adminContentSecurityPolicy, isAdminPath } from "@/lib/routing/admin-csp";
import { decideClosedAction, decideHostAction } from "@/lib/routing/host-split";

/**
 * The hostname the VISITOR asked for — which is emphatically not
 * `request.nextUrl.host`.
 *
 * Next builds the URL it hands middleware from the server's own listen address,
 * not from the request: `resolve-routes.js` composes
 * `${protocol}://${opts.hostname || "localhost"}:${opts.port}${req.url}` unless
 * `experimental.trustHostHeader` is set. `next start` takes no `-H`, so on
 * Railway every request — on the apex AND on `app.` — arrives at middleware
 * reporting `nextUrl.host === "localhost:3000"`. Measured against a live server,
 * not inferred: a request with `Host: app.kept-dev.xyz` reports
 * `nextUrl.host = "localhost:3000"` and `x-forwarded-host = "app.kept-dev.xyz"`.
 *
 * Reading `nextUrl.host` would therefore make `decideHostAction` take the APEX
 * branch for every request in production: `app.kept.host/dashboard` would 307 to
 * itself forever and `app.kept.host/api/auth/*` would 404 — sign-in dead on the
 * one origin allowed to mint a session. Locally it fails the other way (every
 * host looks like `app.`), which is why nothing caught it before deploy.
 *
 * `x-forwarded-host` first because that is what a proxy sets and what Next
 * itself backfills from `Host` (`base-server.js`: `req.headers['x-forwarded-host']
 * ??= req.headers['host']`); the raw `Host` next, for a direct connection; and
 * `nextUrl.host` last so the value is never empty. A client can forge either
 * header, and the worst it buys is a redirect or a 404 on its own request — this
 * is a routing decision, not an authorization one (see the block above).
 */
function requestHost(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-host");
  // Chained proxies append; the FIRST entry is the hostname the client asked for.
  const claimed = (forwarded ?? request.headers.get("host") ?? "").split(",")[0]!.trim();
  return claimed.length > 0 ? claimed : request.nextUrl.host;
}

/**
 * Whether a closed deploy's publish routes may reach their handler: an
 * `Authorization: Bearer …` header or the session cookie, by PRESENCE only. The
 * handler verifies it (`closedModeAccess`) — the edge bundle cannot read the
 * server-only token hashes or the session store (E06a D6).
 */
function carriesCredential(request: NextRequest): boolean {
  return (
    /^Bearer\s+\S/i.test(request.headers.get("authorization") ?? "") ||
    request.cookies.has(SESSION_COOKIE_NAME)
  );
}

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const facts = {
    host: requestHost(request),
    pathname,
    search,
    // `NEXT_PUBLIC_`, never `BETTER_AUTH_URL` — see `host-split.ts`. A
    // server-only read here can be `undefined` in the edge bundle at runtime.
    appUrl: process.env.NEXT_PUBLIC_APP_URL,
  };
  // A closed deploy (`lib/launch.ts`) answers its own cases first; whatever it
  // leaves alone gets the same split rule an open deploy applies.
  const closed = keptOpen()
    ? undefined
    : decideClosedAction({ ...facts, credentialed: carriesCredential(request) });
  if (closed?.kind === "not-open") return notOpenResponse();
  const action = closed ?? decideHostAction(facts);

  // 404 rather than a redirect, and constructed here so the route handler never
  // runs: an apex `/api/auth/*` must emit no `Set-Cookie` at all (D6).
  if (action.kind === "not-found") return new NextResponse(null, { status: 404 });

  // 307 preserves method and body — a 301/302 would downgrade a POST to a GET,
  // and a 308 would be permanently cached for a rule this epic may revisit.
  if (action.kind === "redirect") return NextResponse.redirect(action.location, 307);

  // `/admin/*` alone carries a CSP (E07 task 011, `lib/routing/admin-csp.ts`):
  // on the request, where Next finds the nonce for its scripts, and on the
  // response, where the browser enforces it.
  const csp = isAdminPath(pathname)
    ? adminContentSecurityPolicy(btoa(crypto.randomUUID()))
    : null;
  if (!action.stampPathname && !csp) return NextResponse.next();

  const headers = new Headers(request.headers);
  if (action.stampPathname) headers.set(PATHNAME_HEADER, `${pathname}${search}`);
  if (csp) headers.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers } });
  if (csp) response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  /**
   * Two patterns, because they exist for different reasons.
   *
   * The first is everything except Next's own assets and the API surface. Broad
   * on purpose: a matcher listing the gated routes would be a second place to
   * remember a new `(app)/*` route, and forgetting it would silently lose the
   * return URL. It also catches `/mcp` (E09), which the split rule passes on
   * every host. A path with an extension (`/install.sh`, `/skill.md`,
   * `/llms.txt`, `/.well-known/skills/index.json`) is skipped: a static file,
   * served on any host, open or closed.
   *
   * The second adds back the API surface. The split rule only has an opinion
   * about `/api/auth/*` — every other API path passes through, so
   * `/api/publish`, `/api/anon/*`, `/api/cron/*`, `/api/sites/*` and
   * `/api/health` stay reachable on every origin (the landing hero posts to a
   * relative `/api/publish` from the apex, and the bearer-only `/api/anon/*`
   * routes are E08's keyless agent path). The closed rule needs ALL of it: a
   * closed deploy 404s every API path it does not allow (the JSON `not_open`
   * body), and a route the matcher skipped would be a route the gate never saw.
   *
   * The cost of seeing every API request: Next buffers a request body through
   * middleware up to `middlewareClientMaxBodySize` (10 MB by default), and a
   * body past it reaches the handler truncated. E08 keeps that default on
   * purpose (Arun, 2026-10-22, Q-new-2): raising it would buffer more per
   * in-flight request on Railway. Instead every inline publish or replace body
   * is capped at `INLINE_BODY_MAX_BYTES` (@kept/shared — the same 10 MB, on the
   * wire), and the file-set reader refuses a larger `Content-Length` with
   * `site_too_large` before parsing anything, so a truncated body is never
   * read. Sets between that and the plan's `siteBytes` take the presigned
   * upload path, which never passes through here.
   *
   * Next requires the matcher be statically analyzable, so this cannot be a
   * runtime condition — `pnpm build` is what checks it.
   */
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.[^/]+$).*)",
    "/api/:path*",
  ],
};
