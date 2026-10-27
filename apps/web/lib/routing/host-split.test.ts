/**
 * The apex / `app.` split rule — E05a task 004.
 *
 * The rule is one host comparison, but the cost of getting it wrong is
 * asymmetric and mostly invisible in review: redirect too much and the landing
 * hero's relative `POST /api/publish` starts 307ing (and E08's `curl DELETE`
 * with it); redirect too little and a gated path answers on a hostname that
 * shares a registrable domain with arbitrary user-authored HTML. So each case is
 * asserted individually rather than as a blob.
 *
 * The last block drives `middleware()` itself through a real `NextRequest`,
 * because the load-bearing property of the apex `/api/auth/*` branch is the
 * *absence* of a `Set-Cookie` header — which the pure function cannot express.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { RESERVED_NAMES } from "@kept/shared";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";

import { config, middleware } from "../../middleware";

import { keptOpen } from "../launch";

import { decideClosedAction, decideHostAction, waitlistHref } from "./host-split";

const APP_URL = "https://app.kept-dev.xyz";
const APP_HOST = "app.kept-dev.xyz";
const APEX_HOST = "kept-dev.xyz";
/** Derived by the rule, not configured: `app.kept-dev.xyz` minus its label. */
const APEX_URL = "https://kept-dev.xyz";

/** The `(marketing)` pages the apex owns, other than the landing at `/`. */
const MARKETING_PATHS = ["/promise", "/stats"];

/** Every path the rule has an opinion about, in one place. */
const APEX_PASS_PATHS = [
  "/",
  ...MARKETING_PATHS,
  "/api/publish",
  "/api/anon/tok_abc123",
  "/api/anon/tok_abc123/replace",
  "/api/cron/draft-reminder",
  "/api/sites/swap",
  "/api/uploads",
  "/api/health",
  "/_next/static/chunks/main.js",
];
const APEX_REDIRECT_PATHS = ["/dashboard", "/auth", "/keep/tok_abc123", "/p/tok_abc123"];
const APEX_NOT_FOUND_PATHS = [
  "/api/auth",
  "/api/auth/session",
  "/api/auth/callback/google",
  "/api/auth/sign-in/magic-link",
];

function decide(host: string, pathname: string, search = "", appUrl: string | undefined = APP_URL) {
  return decideHostAction({ host, pathname, search, appUrl });
}

test("on the apex, a gated path redirects to the same path on the app origin", () => {
  for (const pathname of APEX_REDIRECT_PATHS) {
    assert.deepEqual(decide(APEX_HOST, pathname), {
      kind: "redirect",
      location: `${APP_URL}${pathname}`,
    });
  }
});

test("the redirect preserves the query verbatim", () => {
  assert.deepEqual(decide(APEX_HOST, "/auth", "?next=%2Fdashboard"), {
    kind: "redirect",
    location: `${APP_URL}/auth?next=%2Fdashboard`,
  });
  assert.deepEqual(decide(APEX_HOST, "/dashboard", "?x=1&tab=drafts"), {
    kind: "redirect",
    location: `${APP_URL}/dashboard?x=1&tab=drafts`,
  });
  // Case and trailing segments survive: the path is not rewritten.
  assert.deepEqual(decide(APEX_HOST, "/keep/AbC-123"), {
    kind: "redirect",
    location: `${APP_URL}/keep/AbC-123`,
  });
});

test("on the apex, /api/auth/* is 404 — never a redirect (D6)", () => {
  for (const pathname of APEX_NOT_FOUND_PATHS) {
    assert.deepEqual(decide(APEX_HOST, pathname), { kind: "not-found" });
  }
});

test("on the apex, marketing, assets and every non-auth API path pass through", () => {
  for (const pathname of APEX_PASS_PATHS) {
    const action = decide(APEX_HOST, pathname);
    assert.equal(action.kind, "pass", `${pathname} should pass on the apex`);
  }
  // A trailing slash is the same marketing page, not a gated path.
  assert.equal(decide(APEX_HOST, "/promise/").kind, "pass");
});

test("`x-kept-pathname` is stamped on document paths and withheld from API paths", () => {
  assert.deepEqual(decide(APEX_HOST, "/"), { kind: "pass", stampPathname: true });
  assert.deepEqual(decide(APP_HOST, "/dashboard"), { kind: "pass", stampPathname: true });
  assert.deepEqual(decide(APEX_HOST, "/api/publish"), { kind: "pass", stampPathname: false });
  assert.deepEqual(decide(APP_HOST, "/api/auth/session"), { kind: "pass", stampPathname: false });
});

test("on the app origin, / is the dashboard — never the landing", () => {
  assert.deepEqual(decide(APP_HOST, "/"), {
    kind: "redirect",
    location: `${APP_URL}/dashboard`,
  });
  // Same origin, so the `(app)` gate — not this rule — does the signed-out
  // bounce on the next hop. The query survives the hop either way.
  assert.deepEqual(decide(APP_HOST, "/", "?utm=x"), {
    kind: "redirect",
    location: `${APP_URL}/dashboard?utm=x`,
  });
});

test("on the app origin, a marketing page 307s back to the apex that owns it", () => {
  for (const pathname of MARKETING_PATHS) {
    assert.deepEqual(decide(APP_HOST, pathname), {
      kind: "redirect",
      location: `${APEX_URL}${pathname}`,
    });
  }
  // Query intact, and the apex host is DERIVED from the app host rather than
  // configured: `app.kept-dev.xyz` minus its label.
  assert.deepEqual(decide(APP_HOST, "/stats", "?range=30d"), {
    kind: "redirect",
    location: `${APEX_URL}/stats?range=30d`,
  });
  // A trailing slash is the same page, so it mirrors too.
  assert.equal(decide(APP_HOST, "/promise/").kind, "redirect");
});

test("on the app origin, everything that is not the apex's own passes through", () => {
  const passes = [
    ...APEX_PASS_PATHS.filter((p) => p !== "/" && !MARKETING_PATHS.includes(p)),
    ...APEX_REDIRECT_PATHS,
    ...APEX_NOT_FOUND_PATHS,
  ];
  for (const pathname of passes) {
    assert.equal(
      decide(APP_HOST, pathname).kind,
      "pass",
      `${pathname} should pass on the app origin`,
    );
  }
});

test("with one origin serving both halves, nothing is mirrored", () => {
  // Local development: `NEXT_PUBLIC_APP_URL` has no `app.` label, so there is no
  // apex to send anything to and `/` must keep showing the landing.
  for (const pathname of [...APEX_PASS_PATHS, ...APEX_REDIRECT_PATHS, ...APEX_NOT_FOUND_PATHS]) {
    assert.equal(
      decide("localhost:3000", pathname, "", "https://localhost:3000").kind,
      "pass",
      `${pathname} should pass on a single-origin deploy`,
    );
  }
  // Not a hostname-shape coincidence: an `app.` host with nothing behind the
  // label is unusable as a source of an apex, so it degrades the same way.
  assert.equal(decide("app.", "/", "", "https://app.").kind, "pass");
});

test("the host comparison is case-insensitive and includes the port", () => {
  assert.equal(decide("APP.Kept-Dev.XYZ", "/dashboard").kind, "pass");
  assert.equal(decide("localhost:3000", "/dashboard", "", "https://localhost:3000").kind, "pass");
  // Same registrable domain, different host: still the wrong origin.
  assert.equal(decide("notapp.kept-dev.xyz", "/dashboard").kind, "redirect");
  assert.equal(decide("app.kept-dev.xyz.evil.example", "/dashboard").kind, "redirect");
  // A port mismatch is a host mismatch.
  assert.equal(decide("localhost:3001", "/dashboard", "", "https://localhost:3000").kind, "redirect");
});

test("a missing or unusable NEXT_PUBLIC_APP_URL passes everything through", () => {
  for (const appUrl of [undefined, "", "   ", "undefined", "kept-dev.xyz", "javascript:alert(1)"]) {
    for (const pathname of [...APEX_REDIRECT_PATHS, ...APEX_NOT_FOUND_PATHS]) {
      // Called directly: `decide`'s default parameter would swallow `undefined`.
      assert.equal(
        decideHostAction({ host: APEX_HOST, pathname, search: "", appUrl }).kind,
        "pass",
        `${pathname} should pass when NEXT_PUBLIC_APP_URL is ${JSON.stringify(appUrl)}`,
      );
    }
  }
});

test("a trailing slash on the app origin still parses to the same host", () => {
  assert.equal(decide(APP_HOST, "/dashboard", "", `${APP_URL}/`).kind, "pass");
  assert.deepEqual(decide(APEX_HOST, "/dashboard", "", `${APP_URL}/`), {
    kind: "redirect",
    location: `${APP_URL}/dashboard`,
  });
});

// ── the wrapper, driven through a real request ─────────────────────────────

/** Set an env var for the duration of `run`, then put back what was there. */
function withEnv<T>(name: string, value: string | undefined, run: () => T): T {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

/**
 * `middleware()` reads both env vars at call time, so set them per case. Open
 * by default: every case above the closed block is the split rule on an open
 * deploy, and the launch gate fails closed when its variable is unset.
 */
function runMiddleware(
  url: string,
  appUrl: string | undefined,
  open = true,
  headers: Record<string, string> = {},
) {
  return withEnv("NEXT_PUBLIC_APP_URL", appUrl, () =>
    withEnv("NEXT_PUBLIC_KEPT_OPEN", open ? "true" : undefined, () =>
      middleware(new NextRequest(new Request(url, { headers }))),
    ),
  );
}

test("an apex /api/auth/* request is answered 404 with no Set-Cookie at all", () => {
  const response = runMiddleware(`https://${APEX_HOST}/api/auth/callback/google?code=abc`, APP_URL);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.getSetCookie().length, 0);
  // Not a redirect: nothing points a security-sensitive flow at another origin.
  assert.equal(response.headers.get("location"), null);
});

test("an apex gated request is answered 307 to the app origin, query intact", () => {
  const response = runMiddleware(`https://${APEX_HOST}/dashboard?tab=drafts`, APP_URL);
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), `${APP_URL}/dashboard?tab=drafts`);
  assert.equal(response.headers.getSetCookie().length, 0);
});

test("an `app.` root request is answered 307 to /dashboard, not the landing", () => {
  const response = runMiddleware(`https://${APP_HOST}/?utm=x`, APP_URL);
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), `${APP_URL}/dashboard?utm=x`);
  // Middleware answered, so `(marketing)/page.tsx` — which claims `/` on every
  // hostname, route groups being invisible to the URL — never rendered.
  assert.equal(response.headers.get("x-middleware-request-x-kept-pathname"), null);
});

test("an apex landing request passes through carrying the pathname header", () => {
  const response = runMiddleware(`https://${APEX_HOST}/?utm=x`, APP_URL);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("x-middleware-request-x-kept-pathname"), "/?utm=x");
});

test("with NEXT_PUBLIC_APP_URL unset, an apex /api/auth request is not blocked", () => {
  const response = runMiddleware(`https://${APEX_HOST}/api/auth/session`, undefined);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
});

// ── the closed rule (`lib/launch.ts`) ──────────────────────────────────────
// A closed deploy is the waitlist: the landing renders, and only an admin or an
// access token publishes or signs in (E06a §1). Fail-closed is the property
// everything else rests on, so it is asserted first.

test("the launch gate opens on exactly `true` and nothing else", () => {
  for (const value of ["true", " true ", "true\n"]) {
    assert.equal(withEnv("NEXT_PUBLIC_KEPT_OPEN", value, keptOpen), true, JSON.stringify(value));
  }
  for (const value of [undefined, "", "false", "1", "yes", "TRUE", "on", "open"]) {
    assert.equal(withEnv("NEXT_PUBLIC_KEPT_OPEN", value, keptOpen), false, JSON.stringify(value));
  }
});

function decideClosed(
  host: string,
  pathname: string,
  search = "",
  appUrl: string | undefined = APP_URL,
  credentialed = false,
) {
  return decideClosedAction({ host, pathname, search, appUrl, credentialed });
}

const NOT_OPEN = { kind: "not-open" } as const;

/** Served closed on every host: they carry no session, or their own secret. */
const CLOSED_OPEN_APIS = [
  "/api/health",
  "/api/waitlist",
  "/api/waitlist/",
  "/api/waitlist/confirm",
  "/api/waitlist/unsubscribe",
  "/api/founding/review",
  "/api/cron/draft-reminder",
  "/api/cron/visits-sync",
  "/api/cron/waitlist-prune",
];
/** Publish routes: through with a credential, `not-open` without one. */
const CREDENTIAL_APIS = [
  "/api/publish",
  "/api/anon/tok_abc123",
  "/api/anon/tok_abc123/keep",
  "/api/anon/tok_abc123/replace",
  "/api/anon/tok_abc123/reminder",
];
/** The control plane's session-gated API: served on `app.` only. */
const APP_APIS = [
  "/api/auth",
  "/api/auth/get-session",
  "/api/auth/sign-in/magic-link",
  "/api/auth/callback/google",
  "/api/sites",
  "/api/sites/swap",
  "/api/sites/bulk",
  "/api/sites/0b0c1d2e-0000-4000-8000-000000000000/keep",
  "/api/export",
  "/api/names/check",
  "/api/og/123",
  "/api/account",
  "/api/uploads",
];
/** Allowed by no rule: `not-open` on every host. */
const CLOSED_APIS = ["/api", "/api/unknown", "/api/cronx", "/api/publishx", "/api/accounts", "/api/uploads/x"];
/** The control plane's pages: the split rule's, on any host, closed or not. */
const APP_PAGES = [
  "/auth",
  "/auth/keep",
  "/auth/callback",
  "/auth/callback/done",
  "/dashboard",
  "/settings",
  "/site/0b0c1d2e-0000-4000-8000-000000000000",
  "/keep/tok_abc123",
  "/p/tok_abc123",
  "/unsubscribe/tok_abc123",
];
/** Apex pages added by E06a §1, beside the landing, `/promise` and `/stats`. */
const NEW_APEX_PAGES = [
  "/legal/impressum",
  "/legal/privacy",
  "/impressum",
  "/founding",
  "/founding/review",
  "/waitlist/confirm",
  "/waitlist/unsubscribe",
];
/** Pages no rule allows: 307 to the landing's `/`. */
const OTHER_PAGES = ["/legal", "/keep", "/sites", "/authx", "/founding/other"];

test("closed: health, the waitlist, founding review and /api/cron/* pass on every host", () => {
  for (const host of [APEX_HOST, APP_HOST]) {
    for (const pathname of CLOSED_OPEN_APIS) {
      assert.equal(decideClosed(host, pathname), undefined, `${host}${pathname}`);
    }
  }
});

test("closed: /api/publish and /api/anon/* pass only with a credential, on every host", () => {
  for (const host of [APEX_HOST, APP_HOST]) {
    for (const pathname of CREDENTIAL_APIS) {
      assert.deepEqual(decideClosed(host, pathname), NOT_OPEN, `${host}${pathname} bare`);
      assert.equal(
        decideClosed(host, pathname, "", APP_URL, true),
        undefined,
        `${host}${pathname} credentialed`,
      );
    }
  }
});

test("closed: the studio and auth APIs pass on the app host and are not-open on the apex", () => {
  for (const pathname of APP_APIS) {
    assert.equal(decideClosed(APP_HOST, pathname), undefined, `app ${pathname}`);
    assert.deepEqual(decideClosed(APEX_HOST, pathname), NOT_OPEN, `apex ${pathname}`);
    // A credential is no key to these: they have their own session gate.
    assert.deepEqual(decideClosed(APEX_HOST, pathname, "", APP_URL, true), NOT_OPEN, pathname);
  }
});

test("closed: every other API is not-open on every host, credential or not", () => {
  for (const host of [APEX_HOST, APP_HOST]) {
    for (const pathname of CLOSED_APIS) {
      assert.deepEqual(decideClosed(host, pathname), NOT_OPEN, `${host}${pathname}`);
      assert.deepEqual(decideClosed(host, pathname, "", APP_URL, true), NOT_OPEN, pathname);
    }
  }
});

test("closed: on the apex, its pages and assets are the split rule's", () => {
  for (const pathname of [
    "/",
    ...MARKETING_PATHS,
    ...NEW_APEX_PAGES,
    "/promise/",
    "/_next/static/chunks/main.js",
  ]) {
    assert.equal(decideClosed(APEX_HOST, pathname, "?utm=x"), undefined, pathname);
  }
});

test("closed: the control-plane pages are the split rule's, on either host", () => {
  for (const host of [APEX_HOST, APP_HOST]) {
    for (const pathname of APP_PAGES) {
      const action = decideClosed(host, pathname, "?next=%2Fdashboard");
      assert.equal(action, undefined, `${host}${pathname}`);
    }
  }
});

test("closed: any other page 307s to the landing's `/`, on either host", () => {
  for (const host of [APEX_HOST, APP_HOST]) {
    for (const pathname of OTHER_PAGES) {
      assert.deepEqual(
        decideClosed(host, pathname, "?x=1"),
        { kind: "redirect", location: `${APEX_URL}/` },
        `${host}${pathname}`,
      );
    }
  }
});

test("closed: the `app.` host sends the apex pages to the apex, its root included", () => {
  // The split rule would send `/` to `/dashboard` — one hop to the landing
  // instead of two for somebody who typed the bare `app.` host.
  assert.deepEqual(decideClosed(APP_HOST, "/", "?utm=x"), {
    kind: "redirect",
    location: `${APEX_URL}/?utm=x`,
  });
  for (const pathname of [...MARKETING_PATHS, ...NEW_APEX_PAGES]) {
    assert.deepEqual(decideClosed(APP_HOST, pathname, "?utm=x"), {
      kind: "redirect",
      location: `${APEX_URL}${pathname}?utm=x`,
    });
  }
});

test("closed: with one origin, the landing and the control plane are that origin", () => {
  const local = "https://localhost:3000";
  const host = "localhost:3000";
  for (const pathname of ["/", ...MARKETING_PATHS, ...NEW_APEX_PAGES, ...APP_PAGES, ...APP_APIS]) {
    assert.equal(decideClosed(host, pathname, "", local), undefined, pathname);
  }
  for (const pathname of OTHER_PAGES) {
    assert.deepEqual(
      decideClosed(host, pathname, "", local),
      { kind: "redirect", location: `${local}/` },
      pathname,
    );
  }
});

test("closed: without a usable NEXT_PUBLIC_APP_URL the closed pages 404 and the app APIs are not-open", () => {
  for (const appUrl of [undefined, "", "kept-dev.xyz"]) {
    // Not `decideClosed`: its default parameter would turn `undefined` back into APP_URL.
    const unconfigured = (pathname: string) =>
      decideClosedAction({ host: APEX_HOST, pathname, appUrl, credentialed: false });
    for (const pathname of ["/", ...MARKETING_PATHS, ...NEW_APEX_PAGES, ...CLOSED_OPEN_APIS]) {
      assert.equal(unconfigured(pathname), undefined, pathname);
    }
    for (const pathname of [...APP_PAGES, ...OTHER_PAGES]) {
      assert.deepEqual(
        unconfigured(pathname),
        { kind: "not-found" },
        `${pathname} with NEXT_PUBLIC_APP_URL ${JSON.stringify(appUrl)}`,
      );
    }
    for (const pathname of [...APP_APIS, ...CLOSED_APIS, ...CREDENTIAL_APIS]) {
      assert.deepEqual(unconfigured(pathname), NOT_OPEN, pathname);
    }
  }
});

test("open: the apex owns the E06a pages — the app host sends them there", () => {
  for (const pathname of NEW_APEX_PAGES) {
    assert.deepEqual(decide(APEX_HOST, pathname), { kind: "pass", stampPathname: true }, pathname);
    assert.deepEqual(decide(APP_HOST, pathname, "?x=1"), {
      kind: "redirect",
      location: `${APEX_URL}${pathname}?x=1`,
    });
  }
  // The reminder mail links the `app.` origin; one-click unsubscribe meets no redirect.
  assert.deepEqual(decide(APP_HOST, "/unsubscribe/tok_abc123"), {
    kind: "pass",
    stampPathname: true,
  });
});

test("the waitlist link is the landing's, from configuration", () => {
  assert.equal(waitlistHref(APP_URL), `${APEX_URL}/#waitlist`);
  assert.equal(waitlistHref("https://app.kept.host"), "https://kept.host/#waitlist");
  assert.equal(waitlistHref("https://localhost:3000"), "https://localhost:3000/#waitlist");
  assert.equal(waitlistHref(undefined), "/#waitlist");
});

/** The JSON a blocked API call answers with — PRD §1, with the dev apex. */
const NOT_OPEN_BODY = {
  error: "not_open",
  message: "kept opens in December.",
  waitlist: `${APEX_URL}/#waitlist`,
};

test("closed middleware: a bare publish is the JSON not_open 404 before the route handler runs", async () => {
  for (const url of [
    `https://${APEX_HOST}/api/publish`,
    `https://${APP_HOST}/api/publish`,
    `https://${APP_HOST}/api/anon/tok_abc123/keep`,
    `https://${APEX_HOST}/api/unknown`,
  ]) {
    const response = runMiddleware(url, APP_URL, false);
    assert.equal(response.status, 404, url);
    assert.equal(response.headers.get("location"), null, url);
    assert.equal(response.headers.get("x-middleware-next"), null, url);
    assert.deepEqual(await response.json(), NOT_OPEN_BODY, url);
  }
});

test("closed middleware: a Bearer header or the session cookie lets a publish reach its handler", () => {
  const credentials: Record<string, string>[] = [
    { authorization: "Bearer kpt_access_anything" },
    { cookie: "__Host-kept.session_token=present" },
  ];
  for (const headers of credentials) {
    const response = runMiddleware(`https://${APEX_HOST}/api/publish`, APP_URL, false, headers);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-middleware-next"), "1");
  }
  // Presence of something that is not a credential is not enough.
  const notCredentials: Record<string, string>[] = [
    { authorization: "Basic abc" },
    { cookie: "other=1" },
    { authorization: "Bearer " },
  ];
  for (const headers of notCredentials) {
    const response = runMiddleware(`https://${APEX_HOST}/api/publish`, APP_URL, false, headers);
    assert.equal(response.status, 404, JSON.stringify(headers));
  }
});

test("closed middleware: sign-in is reachable on the app host and refused on the apex with no Set-Cookie", () => {
  const app = runMiddleware(`https://${APP_HOST}/api/auth/sign-in/magic-link`, APP_URL, false);
  assert.equal(app.status, 200);
  assert.equal(app.headers.get("x-middleware-next"), "1");

  const apex = runMiddleware(`https://${APEX_HOST}/api/auth/sign-in/magic-link`, APP_URL, false);
  assert.equal(apex.status, 404);
  assert.equal(apex.headers.getSetCookie().length, 0);

  const page = runMiddleware(`https://${APP_HOST}/auth?next=%2Fdashboard`, APP_URL, false);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-middleware-request-x-kept-pathname"), "/auth?next=%2Fdashboard");
});

test("closed middleware: the cron routes reach their own secret check", () => {
  for (const pathname of ["/api/cron/draft-reminder", "/api/cron/visits-sync"]) {
    const response = runMiddleware(`https://${APEX_HOST}${pathname}`, APP_URL, false);
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get("x-middleware-next"), "1", pathname);
  }
});

test("closed middleware: a page no rule allows keeps its redirect, not the JSON body", () => {
  const response = runMiddleware(`https://${APEX_HOST}/sites`, APP_URL, false);
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), `${APEX_URL}/`);
});

test("closed middleware: the landing and the waitlist still answer", () => {
  const landing = runMiddleware(`https://${APEX_HOST}/?utm=x`, APP_URL, false);
  assert.equal(landing.status, 200);
  assert.equal(landing.headers.get("x-middleware-request-x-kept-pathname"), "/?utm=x");

  const waitlist = runMiddleware(`https://${APEX_HOST}/api/waitlist`, APP_URL, false);
  assert.equal(waitlist.status, 200);
  assert.equal(waitlist.headers.get("location"), null);
});

test("open middleware: the API the closed rule takes away is untouched", () => {
  for (const host of [APEX_HOST, APP_HOST]) {
    const response = runMiddleware(`https://${host}/api/publish`, APP_URL, true);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("x-middleware-request-x-kept-pathname"), null);
  }
});

// ── E07 AC41: the report form, the reports API and the admin surface ────────

test("E07 AC41: `report` is already a reserved name, so no page can sit at report.<apex>", () => {
  assert.ok((RESERVED_NAMES as readonly string[]).includes("report"));
});

test("E07 AC41 open: /report is the apex's; /admin/* and /api/admin/* are the app host's", () => {
  assert.deepEqual(decide(APEX_HOST, "/report", "?url=x"), { kind: "pass", stampPathname: true });
  assert.deepEqual(decide(APP_HOST, "/report", "?url=x"), {
    kind: "redirect",
    location: `${APEX_URL}/report?url=x`,
  });
  assert.deepEqual(decide(APP_HOST, "/admin/moderation"), { kind: "pass", stampPathname: true });
  assert.deepEqual(decide(APEX_HOST, "/admin/moderation", "?tab=queue"), {
    kind: "redirect",
    location: `${APP_URL}/admin/moderation?tab=queue`,
  });
  for (const host of [APEX_HOST, APP_HOST]) {
    for (const pathname of ["/api/reports", "/api/admin/moderation/restore"]) {
      assert.deepEqual(decide(host, pathname), { kind: "pass", stampPathname: false }, pathname);
    }
  }
});

test("E07 AC41 closed: /api/reports passes on every host; /api/admin/* only on the app host", () => {
  for (const host of [APEX_HOST, APP_HOST]) {
    assert.equal(decideClosed(host, "/api/reports"), undefined, `${host}/api/reports`);
  }
  // Exact, not a prefix: nothing below it is opened by the entry.
  assert.deepEqual(decideClosed(APEX_HOST, "/api/reports/x"), NOT_OPEN);
  assert.equal(decideClosed(APP_HOST, "/api/admin/moderation/restore"), undefined);
  assert.deepEqual(decideClosed(APEX_HOST, "/api/admin/x"), NOT_OPEN);
  assert.deepEqual(decideClosed(APEX_HOST, "/api/admin/x", "", APP_URL, true), NOT_OPEN);
});

test("E07 AC41 closed: /report is served on the apex; /admin/* is the split rule's", () => {
  assert.equal(decideClosed(APEX_HOST, "/report", "?url=x"), undefined);
  assert.deepEqual(decideClosed(APP_HOST, "/report", "?url=x"), {
    kind: "redirect",
    location: `${APEX_URL}/report?url=x`,
  });
  for (const host of [APEX_HOST, APP_HOST]) {
    assert.equal(decideClosed(host, "/admin/moderation"), undefined, host);
  }
});

test("E07 AC41 closed middleware: reports reach their handler; admin is never served on the apex", async () => {
  const reports = runMiddleware(`https://${APEX_HOST}/api/reports`, APP_URL, false);
  assert.equal(reports.status, 200);
  assert.equal(reports.headers.get("x-middleware-next"), "1");

  const adminApi = runMiddleware(`https://${APEX_HOST}/api/admin/x`, APP_URL, false);
  assert.equal(adminApi.status, 404);
  assert.deepEqual(await adminApi.json(), NOT_OPEN_BODY);

  const adminPage = runMiddleware(`https://${APEX_HOST}/admin/moderation`, APP_URL, false);
  assert.equal(adminPage.status, 307);
  assert.equal(adminPage.headers.get("location"), `${APP_URL}/admin/moderation`);

  const reportPage = runMiddleware(`https://${APEX_HOST}/report`, APP_URL, false);
  assert.equal(reportPage.status, 200);
  assert.equal(reportPage.headers.get("location"), null);
});

// ── E09 task 003: every agent path, classified once ─────────────────────────

/** Credentialed while closed: the keyed REST API, keyed uploads included (Q5). */
const E09_V1_APIS = ["/api/v1/pages", "/api/v1/pages/abc12345", "/api/v1/uploads"];
/** The agent sign-in codes (Q4): open on every host, apex included. */
const E09_AGENT_APIS = ["/api/agent/request-code", "/api/agent/verify-code"];
/** The studio's key management: the app host's. */
const E09_KEY_APIS = ["/api/keys", "/api/keys/0b0c1d2e-0000-4000-8000-000000000000"];
/** Files with an extension: served static, never seen by middleware. */
const E09_STATIC_FILES = ["/install.sh", "/skill.md", "/llms.txt", "/.well-known/skills/index.json"];

test("E09 open: /mcp passes on both hosts, unstamped, and is never redirected", () => {
  for (const host of [APEX_HOST, APP_HOST]) {
    for (const pathname of ["/mcp", "/mcp/"]) {
      assert.deepEqual(decide(host, pathname, "?x=1"), { kind: "pass", stampPathname: false }, `${host}${pathname}`);
    }
  }
  // Only the exact path: nothing below it is opened by the entry.
  assert.equal(decide(APEX_HOST, "/mcp/x").kind, "redirect");
});

test("E09 open: /agents is the apex's — the app host sends it there", () => {
  assert.deepEqual(decide(APEX_HOST, "/agents"), { kind: "pass", stampPathname: true });
  assert.deepEqual(decide(APP_HOST, "/agents", "?tab=mcp"), {
    kind: "redirect",
    location: `${APEX_URL}/agents?tab=mcp`,
  });
});

test("E09 open: /api/v1/*, /api/agent/* and /api/keys pass on both hosts — /api/agent is not /api/auth", () => {
  for (const host of [APEX_HOST, APP_HOST]) {
    for (const pathname of [...E09_V1_APIS, ...E09_AGENT_APIS, ...E09_KEY_APIS, "/api/uploads"]) {
      assert.deepEqual(decide(host, pathname), { kind: "pass", stampPathname: false }, `${host}${pathname}`);
    }
  }
});

test("E09 closed: /mcp is the handler's on every host; /agents is served on the apex", () => {
  for (const host of [APEX_HOST, APP_HOST]) {
    assert.equal(decideClosed(host, "/mcp"), undefined, host);
    assert.equal(decideClosed(host, "/mcp", "", APP_URL, true), undefined, host);
  }
  assert.equal(decideClosed(APEX_HOST, "/agents"), undefined);
  assert.deepEqual(decideClosed(APP_HOST, "/agents"), { kind: "redirect", location: `${APEX_URL}/agents` });
});

test("E09 closed: /api/v1/* passes only with a credential, on every host", () => {
  for (const host of [APEX_HOST, APP_HOST]) {
    for (const pathname of E09_V1_APIS) {
      assert.deepEqual(decideClosed(host, pathname), NOT_OPEN, `${host}${pathname} bare`);
      assert.equal(decideClosed(host, pathname, "", APP_URL, true), undefined, `${host}${pathname} credentialed`);
    }
  }
  // A prefix, so the bare `/api/v1` is not part of it.
  assert.deepEqual(decideClosed(APEX_HOST, "/api/v1", "", APP_URL, true), NOT_OPEN);
});

test("E09 closed: /api/agent/* passes on every host, credential or not", () => {
  for (const host of [APEX_HOST, APP_HOST]) {
    for (const pathname of E09_AGENT_APIS) {
      assert.equal(decideClosed(host, pathname), undefined, `${host}${pathname}`);
    }
  }
});

test("E09 closed: /api/keys passes on the app host only; /api/uploads is unchanged (Q5)", () => {
  for (const pathname of [...E09_KEY_APIS, "/api/uploads"]) {
    assert.equal(decideClosed(APP_HOST, pathname), undefined, `app ${pathname}`);
    assert.deepEqual(decideClosed(APEX_HOST, pathname), NOT_OPEN, `apex ${pathname}`);
    assert.deepEqual(decideClosed(APEX_HOST, pathname, "", APP_URL, true), NOT_OPEN, `apex ${pathname} credentialed`);
  }
  assert.deepEqual(decideClosed(APP_HOST, "/api/keysx"), NOT_OPEN);
});

test("E09 closed middleware: /mcp and /api/agent/* reach their handlers on the apex; a bare /api/v1 call is not_open", async () => {
  for (const path of ["/mcp", "/api/agent/request-code"]) {
    const response = runMiddleware(`https://${APEX_HOST}${path}`, APP_URL, false);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("x-middleware-next"), "1", path);
  }
  const bare = runMiddleware(`https://${APEX_HOST}/api/v1/pages`, APP_URL, false);
  assert.equal(bare.status, 404);
  assert.deepEqual(await bare.json(), NOT_OPEN_BODY);
  const keyed = runMiddleware(`https://${APEX_HOST}/api/v1/pages`, APP_URL, false, {
    authorization: "Bearer kpt_live_x",
  });
  assert.equal(keyed.status, 200);
  assert.equal(keyed.headers.get("x-middleware-next"), "1");
});

test("E09: the matcher skips the agent files (they carry an extension) and catches /mcp and /agents", () => {
  for (const path of E09_STATIC_FILES) {
    assert.equal(unstable_doesMiddlewareMatch({ config, url: path }), false, path);
  }
  for (const path of ["/mcp", "/agents", "/api/v1/pages", "/api/agent/verify-code", "/api/keys"]) {
    assert.equal(unstable_doesMiddlewareMatch({ config, url: path }), true, path);
  }
});
