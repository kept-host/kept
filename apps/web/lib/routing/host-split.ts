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
 *   any host                        → /mcp             pass through (E09 §7)
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
const APEX_PATHS: PathSet = {
  exact: new Set([
    "/",
    "/promise",
    "/stats",
    // E06a §1. `/impressum` is a 308 in `next.config.ts`, which runs before
    // middleware; listed so a host mismatch never decides it first.
    "/impressum",
    "/founding",
    "/founding/review",
    "/waitlist/confirm",
    "/waitlist/unsubscribe",
    // E07 §6.8: the public report form, served while closed.
    "/report",
    // E09: the agents page — the install line, the skill, the MCP config.
    "/agents",
    // E10 (Q21): the expired-draft explainer — static, served while closed.
    "/drafts",
  ]),
  // E10 (Q21): `/remix/` is the server-rendered remix prompt for a kept page —
  // no publish surface, so it is served while closed.
  prefixes: ["/legal/", "/remix/"],
};

/**
 * Paths served on EVERY host and never redirected between apex and `app.` (E09
 * §7): the MCP endpoint an agent's config names once, on whichever origin it
 * was given. Not an API path, so the closed rule lists it here too and leaves
 * closed mode to the handler. `/install.sh`, `/skill.md` and the other agent
 * files carry an extension, so the matcher never sends them here at all.
 */
const ANY_HOST_PATHS: PathSet = {
  exact: new Set(["/mcp"]),
  prefixes: [],
};

/** An exact-path set plus path prefixes (each ending in `/`). */
interface PathSet {
  exact: ReadonlySet<string>;
  prefixes: readonly string[];
}

/** Whether a NORMALIZED path is in `set`. */
function inPathSet(path: string, set: PathSet): boolean {
  return set.exact.has(path) || set.prefixes.some((prefix) => path.startsWith(prefix));
}

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

/**
 * Route handlers that answer while kept is closed (E06a §1), on any host: the
 * release smoke's probe, the waitlist and founding forms, the report form
 * (E07), the agent sign-in codes (E09 Q4: `/api/agent/*`, outside
 * `/api/auth/` so the apex serves them too; their handlers refuse non-admins
 * while closed), and the cron routes —
 * which carry their own secret check (`lib/cron/authorize.ts`). An allow list,
 * so a route added later is closed until someone decides otherwise.
 */
const CLOSED_API_PATHS: PathSet = {
  exact: new Set([
    "/api/health",
    "/api/waitlist",
    "/api/waitlist/confirm",
    "/api/waitlist/unsubscribe",
    "/api/founding/review",
    // E07 §6.8: abuse reports are taken while closed (Turnstile + per-IP limits).
    "/api/reports",
  ]),
  prefixes: ["/api/cron/", "/api/agent/"],
};

/**
 * The routes that create content without a session of their own. Closed, the
 * middleware passes them only when the request carries SOMETHING that could
 * authorise it — an `Authorization: Bearer` header or the session cookie — and
 * the handler's first action decides whether it does (`lib/launch-access.ts`).
 * A presence check only: the edge bundle cannot verify either (D6). `/api/v1/*`
 * (E09) is the keyed REST API, keyed uploads included (Q5); its handlers verify
 * the API key.
 */
const CREDENTIAL_API_PATHS: PathSet = {
  exact: new Set(["/api/publish"]),
  prefixes: ["/api/anon/", "/api/v1/"],
};

/**
 * The control plane's session-gated API, served closed on the `app.` host
 * only. Sign-in is Better Auth's to refuse (admin emails only, §2), and every
 * other route here already answers 401 without a session — which only an admin
 * can have.
 */
const APP_API_PATHS: PathSet = {
  // `/api/uploads` (E08 D5): the presigned large-upload path; 401 without a session.
  // `/api/keys` (E09): the studio's API-key management; 401 without a session.
  // `/api/profile`, `/api/referrals` (E10): the creator's profile (bio, socials,
  // badge) and referral stats; 401 without a session.
  exact: new Set([
    "/api/auth",
    "/api/sites",
    "/api/export",
    "/api/names/check",
    "/api/account",
    "/api/uploads",
    "/api/keys",
    "/api/profile",
    "/api/referrals",
  ]),
  // `/api/admin/` (E07): the moderation actions; the handlers 404 non-admins.
  // `/api/profile/` (E10): `/api/profile/handle`, the handle change.
  prefixes: ["/api/auth/", "/api/sites/", "/api/og/", "/api/admin/", "/api/keys/", "/api/profile/"],
};

/**
 * The control plane's pages, served closed exactly as when open: the split rule
 * routes them to the `app.` host, and the `(app)` gate and the screens' own
 * session checks do the rest. `/unsubscribe/*` is here, not in `APEX_PATHS`:
 * the reminder mail links it on the `app.` origin, and a one-click
 * `List-Unsubscribe` POST must not meet a redirect.
 */
const APP_PAGE_PATHS: PathSet = {
  // `/referrals` (E10): the creator's referral stats.
  exact: new Set(["/auth", "/dashboard", "/settings", "/referrals"]),
  // `/admin/` (E07): the moderation screen; it 404s anyone but an admin.
  prefixes: ["/auth/", "/site/", "/keep/", "/p/", "/unsubscribe/", "/admin/"],
};

/** What `middleware()` should do with this request. */
export type HostAction =
  /** Continue to the route. `stampPathname` drives the `x-kept-pathname` header. */
  | { kind: "pass"; stampPathname: boolean }
  /** Answer 404 here, so the route handler never runs and never sets a cookie. */
  | { kind: "not-found" }
  /** Answer 307 (method- and body-preserving) to this absolute URL. */
  | { kind: "redirect"; location: string };

/**
 * What the closed rule decides: a `HostAction`, or the JSON `not_open` 404 for
 * a blocked API call (`notOpenResponse` in `lib/launch.ts`).
 */
export type ClosedAction = HostAction | { kind: "not-open" };

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
 * Where to send somebody who no longer has an account — E06 task 012.
 *
 * The landing, on the hostname that owns it. `"/"` on the `app.` host would be
 * 307'd to `/dashboard` by the rule above and then bounced to `/auth` by the
 * `(app)` gate, so a just-deleted user's farewell would be a sign-in screen.
 *
 * ⚠️ FROM CONFIGURATION, NEVER FROM THE REQUEST. It derives from the same
 * `NEXT_PUBLIC_APP_URL` the split rule reads and reuses the same two private
 * helpers, so there is no second place for the apex to be worked out — and no
 * `request.url` in the derivation, which on Railway would resolve to the
 * server's own listen address.
 *
 * `"/"` when this deploy has only one hostname (local development), which is
 * correct there: the apex and the app are the same origin and `/` is the
 * landing.
 */
export function farewellHref(appUrl: string | undefined): string {
  const appOrigin = parseAppOrigin(appUrl);
  if (!appOrigin) return "/";
  const apex = apexOriginFor(appOrigin);
  return apex ? `${apex.origin}/` : "/";
}

/**
 * The landing's origin: the apex paired with `app.`, or the one origin when
 * there is no second hostname (local development). `undefined` without a
 * usable `NEXT_PUBLIC_APP_URL`.
 */
function landingOriginFor(appUrl: string | undefined): URL | undefined {
  const appOrigin = parseAppOrigin(appUrl);
  return appOrigin ? (apexOriginFor(appOrigin) ?? appOrigin) : undefined;
}

/**
 * The waitlist on the landing — `https://kept.host/#waitlist` on prod — for the
 * closed deploy's `not_open` body. From configuration, never the request;
 * relative when nothing is configured.
 */
export function waitlistHref(appUrl: string | undefined): string {
  const landing = landingOriginFor(appUrl);
  return `${landing ? landing.origin : ""}/#waitlist`;
}

/**
 * `path` on the landing's origin — from configuration, never the request;
 * relative when nothing is configured.
 */
export function landingHref(appUrl: string | undefined, path: `/${string}`): string {
  const landing = landingOriginFor(appUrl);
  return `${landing ? landing.origin : ""}${path}`;
}

/**
 * An account's referral link — `https://kept.host/?ref={code}` on prod (E10
 * D11). The landing, because that is where `?ref` starts its trip to sign-up.
 */
export function referralHref(appUrl: string | undefined, refCode: string): string {
  return landingHref(appUrl, `/?ref=${encodeURIComponent(refCode)}`);
}

/**
 * The closed rule (E06a §1) — what a deploy that is not yet open
 * (`lib/launch.ts`) does before the split rule runs. `undefined` means "not
 * mine": the request is the split rule's to decide, exactly as on an open
 * deploy.
 *
 *   CLOSED_API_PATHS (health, waitlist,
 *   founding review, reports,
 *   /api/cron/*, /api/agent/*)           → not mine
 *   /api/publish, /api/anon/*,
 *   /api/v1/*                            → not mine with a Bearer header or the
 *                                          session cookie; else `not-open`
 *   APP_API_PATHS (auth, studio, keys,
 *   E10's /api/profile, /api/profile/*,
 *   /api/referrals)                      → not mine on the `app.` host; else
 *                                          `not-open`
 *   every other /api/*                   → `not-open`: the JSON 404, and no
 *                                          route handler runs
 *   _next/*                              → not mine
 *   ANY_HOST_PATHS (/mcp)                → not mine (the handler enforces
 *                                          closed mode)
 *   an apex path on the landing's host
 *   (E10's /drafts and /remix/* too)     → not mine (the split rule passes it)
 *   an apex path elsewhere               → 307 to the same path on the landing's
 *                                          host (`app.`'s `/` included, which
 *                                          the split rule would send to
 *                                          `/dashboard`)
 *   APP_PAGE_PATHS (sign-in, studio,
 *   keep, manage, unsubscribe, admin,
 *   E10's /referrals)                    → not mine (the split rule sends them
 *                                          to the `app.` host)
 *   everything else                      → 307 to the landing's `/`
 *
 * Without a usable `NEXT_PUBLIC_APP_URL` there is no `app.` host to serve the
 * control plane on and nowhere configured to send anyone, so everything but the
 * open APIs and the apex paths is refused — never a redirect built from the
 * request.
 *
 * Not an auth gate: it reads no session. `credentialed` is presence only, and
 * the handlers behind it check the token or the admin session first
 * (`closedModeAccess`). Sign-in is refused inside Better Auth (§2).
 */
export function decideClosedAction({
  host,
  pathname,
  search = "",
  appUrl,
  credentialed,
}: {
  host: string;
  pathname: string;
  search?: string;
  appUrl: string | undefined;
  /** The request carries `Authorization: Bearer …` or the session cookie. */
  credentialed: boolean;
}): ClosedAction | undefined {
  const path = normalizePath(pathname);
  const appOrigin = parseAppOrigin(appUrl);

  if (pathname === "/api" || pathname.startsWith(API_PREFIX)) {
    if (inPathSet(path, CLOSED_API_PATHS)) return undefined;
    if (inPathSet(path, CREDENTIAL_API_PATHS)) {
      return credentialed ? undefined : { kind: "not-open" };
    }
    const onAppHost = !!appOrigin && host.toLowerCase() === appOrigin.host.toLowerCase();
    if (onAppHost && inPathSet(path, APP_API_PATHS)) return undefined;
    return { kind: "not-open" };
  }
  if (pathname.startsWith(FRAMEWORK_PREFIX)) return undefined;
  if (inPathSet(path, ANY_HOST_PATHS)) return undefined;

  const landing = landingOriginFor(appUrl);
  const apex = inPathSet(path, APEX_PATHS);

  if (apex && (!landing || host.toLowerCase() === landing.host.toLowerCase())) {
    return undefined;
  }
  if (!landing) return { kind: "not-found" };
  if (inPathSet(path, APP_PAGE_PATHS)) return undefined;
  return {
    kind: "redirect",
    location: `${landing.origin}${apex ? `${pathname}${search}` : "/"}`,
  };
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
  // A route handler too, and served wherever it was called.
  if (inPathSet(normalizePath(pathname), ANY_HOST_PATHS)) {
    return { kind: "pass", stampPathname: false };
  }

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
    if (inPathSet(path, APEX_PATHS)) {
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
  if (inPathSet(normalizePath(pathname), APEX_PATHS)) return pass;

  return { kind: "redirect", location: `${appOrigin.origin}${pathname}${search}` };
}
