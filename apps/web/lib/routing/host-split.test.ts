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

import { NextRequest } from "next/server";

import { middleware } from "../../middleware";

import { decideHostAction } from "./host-split";

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

/** `middleware()` reads the env var at call time, so set it per case. */
function runMiddleware(url: string, appUrl: string | undefined) {
  const previous = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = appUrl;
  try {
    return middleware(new NextRequest(new Request(url)));
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = previous;
  }
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
