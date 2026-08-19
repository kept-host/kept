/**
 * The apex / `app.` split rule (E05a, D2 + D6) — as one pure function.
 *
 * Both hostnames attach to the SAME Railway service: one build, one deploy, one
 * Next app. The split between "the apex serves the landing" and "`app.` serves
 * the control plane" is therefore not infrastructure, it is a single host
 * comparison made per request — and `middleware.ts` is the only code that sees
 * the `Host` before routing. This module holds the decision so it can be
 * asserted without a request scope; `middleware.ts` stays a thin wrapper.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *   host === the `app.` host        → `/`              307 to `/dashboard`
 *                                     /promise, /stats 307 to the same path on
 *                                                      the apex
 *                                     everything else  pass through
 *   host !== the `app.` host        → /api/auth/*      404, and no `Set-Cookie`
 *                                     /api/*           pass through
 *                                     `(marketing)`    pass through
 *                                     _next/*, assets  pass through
 *                                     everything else  307 to the same path and
 *                                                      query on the `app.` host
 *
 * The split is mirrored in BOTH directions, which amends D2 as originally
 * written. Route groups do not affect the URL, so `(marketing)/page.tsx` owns
 * `/` on every hostname — left alone, the `app.` host serves the marketing
 * landing at its root and the same marketing copy lives at two canonical URLs.
 * So `app.`'s root is sent to `/dashboard` (the `(app)` gate in
 * `app/(app)/layout.tsx` then does the signed-out bounce to `/auth?next=…`, and
 * this file still reads no session), and the other apex-owned paths are sent
 * back to the apex.
 *
 * `/api/auth/*` **404s rather than redirecting** (D6). Exactly one origin may
 * mint a session, with no ambiguity and no redirect hop inside a
 * security-sensitive flow; once `BETTER_AUTH_URL` pins to `app.`, no legitimate
 * request ever targets an apex auth API. The human-facing `/auth` *page* falls
 * through to the general redirect, so a typed URL or a stale link lands on the
 * sign-in screen rather than a dead end. That asymmetry is the decision.
 *
 * Every other `/api/*` path passes through on whatever origin it was called on,
 * and that is load-bearing in three separate places: E01's landing hero posts to
 * a **relative** `/api/publish` from the apex, `/api/anon/*` is the bearer-only
 * keyless agent path E08 depends on (a 307 on a `DELETE` is not transparently
 * followed by every client), and `/api/cron/*` is posted to by
 * `.github/workflows/cron-draft-reminder.yml`.
 *
 * ── NOT AN AUTH GATE ───────────────────────────────────────────────────────
 * The decision needs no session, no database and no fetch — it is `URL` parsing
 * and string comparison, which is what lets it live on the edge runtime. The
 * auth gate is and remains `app/(app)/layout.tsx`.
 */

/**
 * Paths the apex OWNS: the `(marketing)` route group. Short and explicit rather
 * than derived, because there is no way to read a Next route group at runtime
 * and a wrong guess here would either redirect the landing away from its own
 * domain or leak a gated route onto it.
 *
 * Owning them cuts both ways — the apex serves these itself, and the `app.` host
 * sends them back here rather than serving a second copy.
 */
const APEX_PATHS = new Set(["/", "/promise", "/stats"]);

/**
 * What the `app.` host puts at its own root instead of the landing. Gated, so a
 * signed-out visitor continues to `/auth?next=%2Fdashboard` — by the ordinary
 * `(app)` gate, one hop later, not by anything here.
 */
const APP_ROOT_PATH = "/dashboard";

/** The label that distinguishes the control-plane host from its apex. */
const APP_HOST_LABEL = "app.";

/** Next's own asset namespace. Excluded by the matcher too; belt and braces. */
const FRAMEWORK_PREFIX = "/_next/";

/** The route-handler namespace, which is origin-agnostic apart from auth. */
const API_PREFIX = "/api/";

/** The one API subtree that may exist on exactly one origin. */
const AUTH_API_PREFIX = "/api/auth/";

/** What `middleware()` should do with this request. */
export type HostAction =
  /** Continue to the route. `stampPathname` drives the `x-kept-pathname` header. */
  | { kind: "pass"; stampPathname: boolean }
  /** Answer 404 here, so the route handler never runs and never sets a cookie. */
  | { kind: "not-found" }
  /** Answer 307 (method- and body-preserving) to this absolute URL. */
  | { kind: "redirect"; location: string };

/**
 * The `app.` origin, or `undefined` when the value is absent or unusable.
 *
 * Read from **`NEXT_PUBLIC_APP_URL`**, never `BETTER_AUTH_URL`: `NEXT_PUBLIC_`
 * variables are inlined into the client/edge bundle by design, whereas a
 * server-only `process.env` read inside the middleware bundle can be
 * `undefined` at runtime depending on how the image is built — which would turn
 * every apex request into a redirect to `https://undefined/`. Hence the
 * `undefined` return rather than a throw: a deploy that serves the app on one
 * hostname is a degraded product, one that redirects everything into the void is
 * a total outage.
 */
function parseAppOrigin(appUrl: string | undefined): URL | undefined {
  if (typeof appUrl !== "string" || appUrl.trim().length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(appUrl.trim());
  } catch {
    return undefined;
  }
  // A `Location` must be a real web origin; anything else is not something to
  // hand a browser, and an empty host cannot be compared against a request host.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  if (parsed.host.length === 0) return undefined;
  return parsed;
}

/**
 * The apex paired with an `app.` origin — `app.kept.host` → `kept.host` — or
 * `undefined` when this deploy has no second hostname at all.
 *
 * Derived from the one origin that is already configured rather than read from a
 * variable of its own, deliberately: a second variable would have to be set by
 * hand on every track before the mirror worked, so the day it was forgotten the
 * `app.` host would quietly go back to serving marketing — the exact bug this
 * rule exists to close, reintroduced by omission.
 *
 * The `undefined` case is not a degradation, it is local development: with
 * `NEXT_PUBLIC_APP_URL=https://localhost:3000` one origin genuinely serves both
 * halves, so there is nowhere to mirror to and `/` must keep showing the
 * landing. Callers treat it as "pass through", which is what the app did before
 * this rule existed.
 */
function apexOriginFor(appOrigin: URL): URL | undefined {
  const appHost = appOrigin.host.toLowerCase();
  if (!appHost.startsWith(APP_HOST_LABEL)) return undefined;
  const apexHost = appHost.slice(APP_HOST_LABEL.length);
  if (apexHost.length === 0) return undefined;

  const apex = new URL(appOrigin.origin);
  apex.host = apexHost;
  // The `host` setter ignores a value it cannot parse, which would leave the
  // `app.` host in place and turn the mirror into a redirect to itself.
  if (apex.host.toLowerCase() === appHost) return undefined;
  return apex;
}

/** `/promise/` and `/promise` are the same page; compare one shape. */
function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

/**
 * The split rule. `host` and `pathname`/`search` come from `request.nextUrl`;
 * `appUrl` is the raw `process.env.NEXT_PUBLIC_APP_URL`, unvalidated on purpose
 * so the missing-value branch is part of the tested surface.
 */
export function decideHostAction({
  host,
  pathname,
  search = "",
  appUrl,
}: {
  host: string;
  pathname: string;
  search?: string;
  appUrl: string | undefined;
}): HostAction {
  const isApi = pathname === "/api" || pathname.startsWith(API_PREFIX);
  // No route handler reads `x-kept-pathname` — they parse their own request —
  // and the auth endpoints in particular should carry nothing extra.
  const pass: HostAction = { kind: "pass", stampPathname: !isApi };

  const appOrigin = parseAppOrigin(appUrl);
  if (!appOrigin) return pass;

  // Host, not the origin string: the scheme differs between local and deployed,
  // and a substring or `endsWith` test would match `notapp.kept.host`.
  if (host.toLowerCase() === appOrigin.host.toLowerCase()) {
    const apexOrigin = apexOriginFor(appOrigin);
    // One origin serves both halves (local dev): nothing to mirror.
    if (!apexOrigin) return pass;

    const path = normalizePath(pathname);
    // `(marketing)/page.tsx` would otherwise answer here too — route groups do
    // not affect the URL, so `/` is claimed by the landing on every hostname.
    if (path === "/") {
      return { kind: "redirect", location: `${appOrigin.origin}${APP_ROOT_PATH}${search}` };
    }
    // One canonical URL per marketing page, and it is the apex's.
    if (APEX_PATHS.has(path)) {
      return { kind: "redirect", location: `${apexOrigin.origin}${pathname}${search}` };
    }
    return pass;
  }

  // ── Everything below is the apex (or any other non-`app.` hostname) ──
  if (isApi) {
    return pathname === "/api/auth" || pathname.startsWith(AUTH_API_PREFIX)
      ? { kind: "not-found" }
      : pass;
  }
  if (pathname.startsWith(FRAMEWORK_PREFIX)) return pass;
  if (APEX_PATHS.has(normalizePath(pathname))) return pass;

  return { kind: "redirect", location: `${appOrigin.origin}${pathname}${search}` };
}
