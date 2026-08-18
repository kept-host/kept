import { publishErrorSchema } from "@kept/shared";
import { expect, test } from "@playwright/test";
import { config } from "dotenv";

import {
  deleteDrafts,
  pageHtml,
  servingDomain,
  SKIP_LIVE_PUBLISH,
  trackDrafts,
} from "./live-publish";
import { rawRequest } from "./raw-request";

/**
 * The apex / `app.` split, over the wire — E05a task 008, epic criteria 3–5.
 *
 * `lib/routing/host-split.test.ts` drills `decideHostAction` as a pure
 * function. This file asserts the half a unit test structurally cannot: that
 * `middleware.ts` feeds it the hostname the VISITOR asked for, and that the
 * decision survives Next's routing to become a real status line.
 *
 * ── HOW TWO HOSTNAMES ARE EXERCISED AGAINST ONE LOCAL SERVER ───────────────
 * By sending the header a proxy sends. `app.kept-dev.xyz` does not resolve yet
 * — that DNS record is task 009's human work — and inventing a hostname to
 * claim a criterion would prove nothing anyway. What the rule actually consumes
 * is one string, and on Railway that string arrives as `x-forwarded-host`. So
 * the specs below send it, exactly as the proxy will, against the local server.
 *
 * ⚠️ THIS IS A REAL TRIPWIRE, NOT A CEREMONY. `request.nextUrl.host` is NOT the
 * requested hostname: Next composes the URL it hands middleware from the
 * SERVER's own listen address (`resolve-routes.js`:
 * `${protocol}://${opts.hostname || "localhost"}:${opts.port}${req.url}`), and
 * `next start` takes no `-H`. Measured against this very server: a request with
 * `Host: app.kept-dev.xyz` reports `nextUrl.host === "localhost:3000"`. Wiring
 * the rule to `nextUrl.host` therefore makes every deployed request — on the
 * apex AND on `app.` — take the apex branch: `app.` redirects to itself forever
 * and `app./api/auth/*` 404s, i.e. sign-in dies on the one origin allowed to
 * mint a session, while every local spec stays green. These tests fail if that
 * regresses, in both directions: the apex header must redirect, and its absence
 * must not.
 *
 * ── WHAT LOCAL CANNOT SHOW, AND WHY THAT IS NOT A WEAKER ASSERTION ─────────
 * `middleware.ts` returns an ABSOLUTE `Location` (`https://app.…/path?query`).
 * Next relativizes a middleware `Location` whose origin matches the server's own
 * (`resolve-routes.js` → `getRelativeURL`), and locally the `app.` origin IS the
 * server, so the header arrives as `/path?query`. Resolving it against the
 * request URL recovers the same absolute URL, which is what the assertions
 * below do — a relative and an absolute `Location` are the same instruction to
 * a client. On deployed dev the two origins differ and the header stays
 * absolute; that shape is task 009's to observe.
 */
config({ path: ".env.local", quiet: true });

/**
 * The `app.` origin the rule redirects TO, read from the same variable
 * `middleware.ts` reads. Absent, `decideHostAction` passes everything through
 * by design and there is no split to assert.
 */
const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "") ?? "";

const SKIP: string | false = APP_URL
  ? false
  : "NEXT_PUBLIC_APP_URL absent — the split rule is inert without it (`host-split.ts`)";

/**
 * A hostname that is not the `app.` host — which is the whole of what "the
 * apex" means to the rule. `KEPT_BASE_DOMAIN` is the real apex on whichever
 * track this run points at (`kept-dev.xyz` on dev), so it is used when present
 * rather than a literal that would be wrong on the other track.
 */
const APEX_HOST = process.env.KEPT_BASE_DOMAIN?.trim() || "kept-dev.xyz";

/** As a proxy sends it. `middleware.ts` prefers this over the raw `Host`. */
const fromApex = { "x-forwarded-host": APEX_HOST };

/** The three routes whose reachability on the apex the product depends on. */
const NEEDS_DB = !process.env.DATABASE_URL?.trim();

/**
 * Everything `createAuth()` validates before it can be constructed at all.
 *
 * A route that reaches `requireSession()` or the Better Auth API answers **500**
 * with these empty — by design (`lib/storage/env.ts` fails loud rather than
 * degrading), which is why every other suite guards on the same seven names.
 *
 * ⚠️ THIS GUARD IS DELIBERATELY NOT ON THE DESCRIBE. The tests that guard bug 1
 * — the `nextUrl.host` vs `Host` regression documented above — are pure routing
 * decisions: middleware answers them before any route runs, so they need no
 * secret, and CI is precisely where they earn their keep. Skipping this file
 * wholesale would retire the tripwire in the only environment that runs on
 * every push. Gate the individual tests that genuinely cannot work, nothing
 * more.
 */
const AUTH_VARS = [
  "BETTER_AUTH_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
] as const;

const missingAuthVars = AUTH_VARS.filter((name) => !process.env[name]?.trim());

const SKIP_AUTH: string | false =
  missingAuthVars.length > 0
    ? `auth credentials absent (${missingAuthVars.join(", ")}) — a route that reaches ` +
      `createAuth() answers 500, so the split decision could not be observed`
    : false;

/**
 * A non-marketing path that exists nowhere in the route tree.
 *
 * The split rule is a HOST comparison and nothing else, so the cleanest subject
 * for it is a path with no page, no session, no database and no auth behind it:
 * on the apex it must 307 to the `app.` origin, and on the `app.` host it must
 * fall through to an ordinary 404. Both directions then depend on exactly one
 * variable — which hostname the middleware believed it was serving — which is
 * what makes this the tripwire that has to run everywhere, credentials or not.
 */
const PROBE_PATH = "/e05a-008-split-probe";

test.describe("the apex / `app.` split", () => {
  test.skip(!!SKIP, SKIP || undefined);

  test("a gated path on the apex 307s to the same path and query on the `app.` origin", async ({
    request,
    baseURL,
  }) => {
    const path = "/dashboard?x=1&y=2";

    const response = await request.get(path, { headers: fromApex, maxRedirects: 0 });

    // 307 exactly: a 302 would downgrade a POST to a GET and a 308 would be
    // cached permanently for a rule this epic may still revisit.
    expect(response.status()).toBe(307);

    const location = response.headers()["location"];
    expect(location, "the apex must answer with a Location").toBeDefined();
    // Path AND query intact, on the `app.` origin — resolved, so a relative and
    // an absolute header are judged as the same instruction (see the block
    // comment). `?x=1&y=2` surviving is the assertion; a rule that rebuilt the
    // URL from `pathname` alone would silently drop it.
    expect(new URL(location!, `${baseURL}${path}`).href).toBe(`${APP_URL}${path}`);

    // Middleware answered, not the route: a redirect emitted after the page had
    // rendered would carry the document with it, and rendering a gated page on
    // the apex at all is the thing the split exists to prevent.
    expect(await response.text()).not.toContain("<html");
  });

  test("the same path WITHOUT the apex header is not redirected at all", async ({
    request,
    baseURL,
  }) => {
    /**
     * THE OTHER HALF OF THE TRIPWIRE, and the half that fails if the rule is
     * ever rewired to `request.nextUrl.host`.
     *
     * Locally `nextUrl.host` and the `app.` host are the same string, so a
     * broken rule still passes this request through and this test still goes
     * green — but paired with the test above (same path, same server, one extra
     * header, opposite outcome) the only thing that can explain both results is
     * that middleware read the HEADER. `PROBE_PATH` keeps the pair honest: no
     * page, no session, no database, so neither direction can be explained by
     * anything but the host.
     */
    const withApex = await request.get(PROBE_PATH, { headers: fromApex, maxRedirects: 0 });
    expect(withApex.status()).toBe(307);
    expect(new URL(withApex.headers()["location"] ?? "", `${baseURL}${PROBE_PATH}`).href).toBe(
      `${APP_URL}${PROBE_PATH}`,
    );

    // Identical request, one header removed: no split, no `Location`, just the
    // ordinary 404 a path with no route deserves.
    const withoutApex = await request.get(PROBE_PATH, { maxRedirects: 0 });
    expect(withoutApex.status()).toBe(404);
    expect(withoutApex.headers()["location"]).toBeUndefined();
  });

  test("signed out, following the apex redirect lands on /auth?next=/dashboard", async ({
    page,
    request,
    baseURL,
  }) => {
    // Hop two lands on the `(app)` gate and then on the sign-in screen, both of
    // which construct Better Auth. The split decision itself (hop one) is
    // asserted without credentials by the two tests above; this is the only
    // thing here that genuinely cannot run without them.
    test.skip(!!SKIP_AUTH, SKIP_AUTH || undefined);
    test.skip(
      APP_URL !== new URL(baseURL!).origin,
      `NEXT_PUBLIC_APP_URL (${APP_URL}) is not this harness's origin — following the ` +
        `redirect would leave the server under test`,
    );

    // Hop one, on the apex.
    const bounced = await request.get("/dashboard", { headers: fromApex, maxRedirects: 0 });
    expect(bounced.status()).toBe(307);
    const target = new URL(bounced.headers()["location"] ?? "", `${baseURL}/dashboard`);
    expect(target.href).toBe(`${APP_URL}/dashboard`);

    // Hop two, followed the way a client follows it: resolve the `Location` and
    // request THAT — on the `app.` origin, where the browser now is. Replaying
    // the apex header here would model a browser that lies about which host it
    // reached, and would loop forever by design.
    await page.goto(target.href);

    // Two hops in total (see `middleware.ts`): the split, then the gate.
    await expect(page).toHaveURL(/\/auth\?/);
    expect(new URL(page.url()).searchParams.get("next")).toBe("/dashboard");
    await expect(page.getByRole("heading", { name: "Sign in to kept" })).toBeVisible();
  });

  test("the apex cannot mint a session: /api/auth/* 404s, sets no cookie, and never redirects", async ({
    baseURL,
  }) => {
    // Raw https, so the exact bytes are ours and the `Set-Cookie` count is the
    // server's answer rather than a client's summary of it.
    const attempts: [string, string, string | undefined][] = [
      // A POST shape — the endpoint that mints a magic link.
      [
        "POST",
        "/api/auth/sign-in/magic-link",
        JSON.stringify({ email: "e05a-008@kept-e05a.invalid" }),
      ],
      // …and a GET shape — the callback that would set the session cookie.
      ["GET", "/api/auth/callback/google?code=e05a-008&state=e05a-008", undefined],
    ];

    for (const [method, path, body] of attempts) {
      const response = await rawRequest(method, `${baseURL}${path}`, {
        headers: {
          ...fromApex,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body,
      });
      const where = `${method} ${path}`;

      // D6: 404, not a redirect. A 307 into a security-sensitive flow would put
      // exactly the ambiguity this decision removes back on the wire.
      expect(response.status, where).toBe(404);
      expect(response.headers["location"], where).toBeUndefined();

      // THE ASSERTION THIS TEST EXISTS FOR: the absence of the header. The
      // route handler never ran, so there is nothing to set a cookie.
      expect(response.setCookies, `${where} emitted Set-Cookie`).toEqual([]);
    }
  });

  test("the same two endpoints are alive on the `app.` host — the 404 is the split, not a missing route", async ({
    baseURL,
  }) => {
    // Without this, the test above would pass just as well against an app that
    // had no auth API at all.
    const magicLink = await rawRequest("POST", `${baseURL}/api/auth/sign-in/magic-link`, {
      headers: { "content-type": "application/json", origin: new URL(baseURL!).origin },
      // Deliberately malformed: Better Auth refuses it at validation, so this
      // spends none of Resend's daily quota and sends no mail.
      body: JSON.stringify({}),
    });
    expect(magicLink.status, magicLink.body).not.toBe(404);

    const callback = await rawRequest(
      "GET",
      `${baseURL}/api/auth/callback/google?code=e05a-008&state=e05a-008`,
    );
    expect(callback.status, callback.body).not.toBe(404);

    // The read side too, so the claim covers the whole `/api/auth/` subtree
    // rather than the two endpoints the apex test happens to name.
    const session = await rawRequest("GET", `${baseURL}/api/auth/get-session`);
    expect(session.status, session.body).not.toBe(404);

    // `not 404` and not `200` ON PURPOSE. The claim here is about the URL
    // space: these paths resolve to a route on the `app.` host, which is what
    // makes the apex's 404 above attributable to the split. What the route then
    // ANSWERS depends on credentials this run may not have — with the auth slots
    // empty it is a 500 by design — and asserting a status that encodes that
    // would make this test a credentials check wearing a routing test's name.
  });

  test("/auth on the apex redirects rather than 404s — D6's asymmetry", async ({
    request,
    baseURL,
  }) => {
    const response = await request.get("/auth", { headers: fromApex, maxRedirects: 0 });

    // The human-facing sign-in PAGE falls through to the general redirect, so a
    // typed URL or a stale link lands on the screen instead of a dead end. Only
    // the auth API 404s.
    expect(response.status()).toBe(307);
    expect(new URL(response.headers()["location"] ?? "", `${baseURL}/auth`).href).toBe(
      `${APP_URL}/auth`,
    );
  });

  test("the marketing pages and every non-auth API stay on the apex", async ({
    request,
  }) => {
    for (const path of ["/", "/promise", "/stats", "/api/health"]) {
      const response = await request.get(path, { headers: fromApex, maxRedirects: 0 });
      expect(response.status(), `${path} must be served by the apex itself`).toBe(200);
    }
  });

  test("/api/anon/* is reachable on the apex — E08's keyless path, bearer-only", async ({
    request,
  }) => {
    test.skip(NEEDS_DB, "DATABASE_URL absent — the anon routes resolve their token in Postgres");

    // A fictional token, so the honest answer is the anonymous manage API's
    // uniform 404. The point is WHICH 404: middleware's is an empty body, the
    // handler's is the shared error shape — so parsing the body is what proves
    // the request reached the route rather than being intercepted.
    const response = await request.delete(`/api/anon/${"A".repeat(43)}`, {
      headers: fromApex,
      maxRedirects: 0,
    });
    expect(response.status()).toBe(404);
    // A 307 on a DELETE is not transparently followed by every client, which is
    // why this route must never be redirected.
    expect(response.headers()["location"]).toBeUndefined();
    publishErrorSchema.parse(await response.json());
  });

  test("on the `app.` host nothing is redirected by the split, and `Host` alone drives it too", async ({
    request,
    baseURL,
  }) => {
    const appHost = new URL(APP_URL).host;

    // Named explicitly rather than omitted: this asserts the rule's positive
    // branch — the `app.` host serves the WHOLE app, marketing pages included.
    // (`/api/auth/*` on this host is covered above, where the assertion can be
    // about the URL space rather than about a status that needs credentials.)
    for (const path of ["/", "/promise", "/stats", "/auth", "/api/health"]) {
      const response = await request.get(path, {
        headers: { "x-forwarded-host": appHost },
        maxRedirects: 0,
      });
      expect(response.status(), `${path} on ${appHost}`).toBe(200);
    }

    // And a `Host` header alone drives the same decision — a proxy that
    // forwards only `Host` must not silently disable the split.
    const viaHost = await rawRequest("GET", `${baseURL}${PROBE_PATH}`, {
      headers: { host: APEX_HOST },
    });
    expect(viaHost.status).toBe(307);
    expect(new URL(viaHost.headers["location"] as string, `${baseURL}${PROBE_PATH}`).href).toBe(
      `${APP_URL}${PROBE_PATH}`,
    );
  });

  test("the apex still serves the landing, and the hero's relative /api/publish still mints", async ({
    page,
    request,
  }) => {
    test.skip(!!SKIP_LIVE_PUBLISH, String(SKIP_LIVE_PUBLISH));
    test.setTimeout(60_000);

    // Every request this page makes claims the apex — the document, `/_next/*`,
    // and the hero's own relative `POST /api/publish`. If the matcher were ever
    // widened to catch `/api/publish`, the call would 307 to the `app.` origin,
    // become cross-origin, and the landing's one interaction would break.
    await page.setExtraHTTPHeaders(fromApex);
    const drafts = trackDrafts(page);

    try {
      const landing = await page.goto("/");
      expect(landing?.status(), "the apex must serve the landing itself").toBe(200);
      await expect(page).toHaveTitle("kept");
      await page.waitForLoadState("networkidle");

      const published = page.waitForResponse(
        (res) => res.url().includes("/api/publish") && res.status() === 201,
      );

      await page.setInputFiles('input[type="file"]', {
        name: "hello.html",
        mimeType: "text/html",
        buffer: Buffer.from(pageHtml(`e05a-008-apex-${crypto.randomUUID().slice(0, 8)}`)),
      });

      const body = (await (await published).json()) as { live_url: string; slug: string };
      const host = new URL(body.live_url).host;
      expect(host).toBe(`${body.slug}.${servingDomain()}`);

      // …and the tile says so, which is what a visitor on the apex actually sees.
      await expect(page.locator('[data-face="live"]')).toHaveCSS("opacity", "1");
      await expect(page.locator('[data-face="live"] span').last()).toHaveText(host);
    } finally {
      await deleteDrafts(request, drafts);
    }
  });
});
