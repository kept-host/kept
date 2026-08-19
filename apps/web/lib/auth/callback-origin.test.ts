/**
 * `/auth/callback` redirects to the CONFIGURED origin, not the listen address.
 *
 * ── THE BUG THIS EXISTS TO CATCH ───────────────────────────────────────────
 * `app/auth/callback/route.ts` is the last hop of the keep flow: a visitor
 * pressed "Keep it forever", was handed to GitHub, Google or their inbox, and
 * comes back here to be sent on to the result screen. It used to absolutise
 * that redirect against `request.url` — and Next does not build `request.url`
 * from the `Host` header. It composes it from the SERVER's own listen address
 * (`resolve-routes.js`: `${protocol}://${opts.hostname || "localhost"}:${opts
 * .port}${req.url}`) unless `experimental.trustHostHeader` is set, and
 * `next start` takes no `-H`. Railway runs the container on `PORT=8080`, so
 * every returning visitor was redirected to `https://localhost:8080/…` and the
 * keep died one hop from finishing. Measured on deployed dev before the fix:
 *
 *     GET https://app.kept-dev.xyz/auth/callback
 *     → 303, location: https://localhost:8080/dashboard
 *
 * Signing in at `/auth` was unaffected because its `callbackURL` is
 * `/dashboard` — Better Auth resolves that against its own configured
 * `baseURL` and this route never runs. Only the keep path routes through here,
 * which is why one door worked and the other did not.
 *
 * ── WHY A UNIT TEST AND NOT A SPEC ─────────────────────────────────────────
 * `e2e/host-split.spec.ts` is the precedent for this class of defect, and it
 * can only work because middleware's two hostnames can be put on the wire with
 * one header. This one cannot: the poisoned value is the server's listen
 * address, which no header changes, and locally it is byte-identical to
 * `NEXT_PUBLIC_APP_URL` — that is precisely why the whole suite stayed green
 * through the bug. Handing the handler a `NextRequest` whose URL carries a
 * listen address reproduces the deployed condition exactly, in-process, with
 * nothing stubbed: a real `NextRequest`, the real handler, the real
 * `authConfig()`. The branch exercised below returns before any session or
 * database read, so it needs no credentials and runs on every push.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

/**
 * `authConfig()` validates the secret alongside the URL, and this branch of the
 * handler transmits neither. Fill only what is missing, as the other auth
 * drills do, so a real `.env.local` always wins and this can never paper over a
 * misconfiguration.
 */
for (const [name, value] of Object.entries({
  BETTER_AUTH_SECRET: "callback-origin-drill-secret-not-used-for-anything-real",
  BETTER_AUTH_URL: "https://localhost:3000",
})) {
  if (!process.env[name]?.trim()) process.env[name] = value;
}

/**
 * The shape Railway serves: the process listens on `$PORT` and knows nothing
 * about the hostname the visitor typed. `8080` is the real deployed value.
 */
const LISTEN_ORIGIN = "https://localhost:8080";

async function callback(target: string) {
  const { authConfig } = await import("../storage/env");
  const { NextRequest } = await import("next/server");
  const { GET } = await import("../../app/auth/callback/route");

  const baseUrl = authConfig().baseUrl;
  // If these ever coincide the assertions below prove nothing — fail loudly
  // rather than going green on a tautology.
  assert.notEqual(
    new URL(baseUrl).origin,
    LISTEN_ORIGIN,
    "the configured origin must differ from the fabricated listen address, or " +
      "this test cannot tell a fixed handler from a broken one",
  );

  const response = await GET(new NextRequest(new URL(target, LISTEN_ORIGIN)));
  return { response, baseUrl, location: response.headers.get("location") ?? "" };
}

test("the post-sign-in redirect is built from the configured origin, not the listen address", async () => {
  const { response, baseUrl, location } = await callback(
    "/auth/callback?next=%2Fdashboard%3Ftab%3Ddrafts",
  );

  assert.equal(response.status, 303);
  // Path and query intact, on the origin the OAuth redirect URIs and the
  // session cookie belong to.
  assert.equal(location, `${baseUrl}/dashboard?tab=drafts`);
  // Stated separately and on purpose: this is the regression itself. Before the
  // fix this header read `https://localhost:8080/dashboard?tab=drafts`.
  assert.notEqual(new URL(location).origin, LISTEN_ORIGIN);
});

test("`?next=` is still filtered by safeReturnPath — an off-origin one falls back to APP_HOME", async () => {
  const { location, baseUrl } = await callback(
    "/auth/callback?next=https%3A%2F%2Fevil.example%2Fphish",
  );

  // The open-redirect guard is unchanged: an absolute `next` is discarded, not
  // resolved. Pinning the base is what makes that guarantee total — a redirect
  // built from a request-derived origin could be steered even when the path
  // could not.
  assert.equal(location, `${baseUrl}/dashboard`);
});

test("the pending-keep cookie is expired on the redirect, so the intent stays read-once", async () => {
  const { response } = await callback("/auth/callback");

  const setCookie = response.headers.getSetCookie().join("\n");
  assert.match(setCookie, /kept\.pending_keep=;/);
  assert.match(setCookie, /Max-Age=0/);
});
