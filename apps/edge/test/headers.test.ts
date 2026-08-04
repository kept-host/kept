// Response headers across every response class (task 006).
//
// Every byte this Worker serves is arbitrary HTML written by an anonymous
// stranger, so the headers must assume it is hostile — and they must be present
// on EVERY response class, not just the 200. This file enumerates all six
// classes the serve path can produce (200, 301, 304, 404, 451, 410) and applies
// the same header expectations to each, so a branch added in a later epic that
// builds its own `Response` fails here rather than in a scanner report.
//
// The "no CORS header anywhere" group matters on its own: a hosted page is not
// an API, and it must not become one by default at any point in the epic.

import { beforeAll, describe, expect, it } from "vitest";

import {
  APEX_ORIGIN,
  BASE_DOMAIN,
  describeResponse,
  dispatch,
  evictFromCache,
  FORBIDDEN_CORS_HEADERS,
  headerNames,
  objectKey,
  requestFor,
  requestUrl,
  seedSite,
} from "./fixtures";
import { env } from "cloudflare:test";

/** One live request of every response class the serve path can produce. */
interface ResponseCase {
  name: string;
  status: number;
  build: () => Promise<Response>;
  /** True when the class carries a user-controlled body and needs the user CSP. */
  userContent: boolean;
}

let liveEtag = "";

const CASES: ResponseCase[] = [
  {
    name: "200 live page content",
    status: 200,
    userContent: true,
    build: () => dispatch(requestFor("hdr-live")),
  },
  {
    name: "301 reserved-label redirect",
    status: 301,
    userContent: false,
    build: () => dispatch(requestUrl(`https://www.${BASE_DOMAIN}/dashboard?a=1`)),
  },
  {
    // Revalidation of a page that is already in the edge cache — the common
    // case in production, and the one that produces a 304 through the Cache API
    // rather than through R2's `onlyIf`. The `200 live page content` case above
    // runs first and populates the entry this revalidates against.
    name: "304 conditional revalidation",
    status: 304,
    userContent: false,
    build: () => dispatch(requestFor("hdr-live", "/", { headers: { "If-None-Match": liveEtag } })),
  },
  {
    name: "404 branded not-found",
    status: 404,
    userContent: false,
    build: () => dispatch(requestFor("hdr-never-published")),
  },
  {
    name: "451 branded suspended",
    status: 451,
    userContent: false,
    build: () => dispatch(requestFor("hdr-suspended")),
  },
  {
    name: "410 branded expired draft",
    status: 410,
    userContent: false,
    build: () => dispatch(requestFor("hdr-expired")),
  },
];

describe("response classes", () => {
  beforeAll(async () => {
    const live = await seedSite("hdr-live");
    await seedSite("hdr-suspended", { status: "under_review" });
    await seedSite("hdr-expired", { status: "expired" });

    const head = await env.KEPT_R2.head(objectKey(live));
    if (head === null) throw new Error(`fixture not seeded: ${objectKey(live)}`);
    liveEtag = head.httpEtag;
  });

  it("can produce all six classes, so the header assertions below are not vacuous", async () => {
    for (const { name, status, build } of CASES) {
      const response = await build();
      expect(response.status, `${name}: got ${describeResponse(response)}`).toBe(status);
    }
  });

  it("never adds a CORS header to any response class", async () => {
    for (const { name, build } of CASES) {
      const response = await build();
      for (const header of FORBIDDEN_CORS_HEADERS) {
        expect(
          response.headers.get(header),
          `${name} carries ${header}. A hosted page is not an API and must not become one by default. Headers present: ${JSON.stringify(headerNames(response))}`,
        ).toBeNull();
      }
    }
  });

  it("never adds a fingerprinting header of our own", async () => {
    for (const { name, build } of CASES) {
      const response = await build();
      expect(response.headers.get("x-powered-by"), `${name} must not advertise the stack`).toBeNull();
    }
  });

  it("301s to the control plane and never proxies it", async () => {
    // The serve path must never fetch the control plane, so a reserved label is
    // answered with a redirect the browser follows, not with borrowed content.
    const response = await dispatch(requestUrl(`https://app.${BASE_DOMAIN}/settings`));

    expect(response.status, `expected 301, got ${describeResponse(response)}`).toBe(301);
    expect(response.headers.get("location"), "the redirect target is KEPT_APEX_ORIGIN from [vars]").toBe(
      `${APEX_ORIGIN}/settings`,
    );
  });
});

// The security-header set is built by `apps/edge/src/headers.ts` (task 006):
// every response goes through `buildResponse(body, { status, kind, headers })`
// and `index.ts` contains zero bare `new Response`.
describe("security headers (task 006)", () => {
  beforeAll(async () => {
    const live = await seedSite("hdr-live");
    await seedSite("hdr-suspended", { status: "under_review" });
    await seedSite("hdr-expired", { status: "expired" });

    const head = await env.KEPT_R2.head(objectKey(live));
    if (head === null) throw new Error(`fixture not seeded: ${objectKey(live)}`);
    liveEtag = head.httpEtag;
  });

  it("sets nosniff on every response class", async () => {
    for (const { name, build } of CASES) {
      const response = await build();
      expect(
        response.headers.get("x-content-type-options"),
        `${name} must be nosniff — it is the other half of the Worker-owned Content-Type map`,
      ).toBe("nosniff");
    }
  });

  it("sets a conservative Referrer-Policy on every response class", async () => {
    const allowed = ["strict-origin-when-cross-origin", "same-origin", "no-referrer"];
    for (const { name, build } of CASES) {
      const response = await build();
      expect(
        allowed,
        `${name} has Referrer-Policy=${response.headers.get("referrer-policy")}, which is looser than strict-origin-when-cross-origin`,
      ).toContain(response.headers.get("referrer-policy"));
    }
  });

  it("sets a framing policy and the cross-origin isolation headers on every response class", async () => {
    for (const { name, build } of CASES) {
      const response = await build();
      const names = headerNames(response);

      expect(
        names.includes("x-frame-options") || (response.headers.get("content-security-policy") ?? "").includes("frame-ancestors"),
        `${name} must constrain framing via X-Frame-Options or CSP frame-ancestors. Headers: ${JSON.stringify(names)}`,
      ).toBe(true);
      expect(response.headers.get("cross-origin-resource-policy"), `${name} must set CORP`).toBeTruthy();
      expect(response.headers.get("cross-origin-opener-policy"), `${name} must set COOP`).toBeTruthy();
    }
  });

  it("constrains form-action and base-uri in the user-content CSP", async () => {
    const response = await dispatch(requestFor("hdr-live"));
    const csp = response.headers.get("content-security-policy") ?? "";

    expect(csp, `user content must carry a CSP, got headers ${JSON.stringify(headerNames(response))}`).toBeTruthy();
    expect(csp, "form-action must be constrained so a hosted page cannot post to the control plane").toContain("form-action");
    expect(csp, "base-uri must be constrained so a hosted page cannot rewrite its own resolution base").toContain("base-uri");
  });

  it("does not break an inline <style>/<script> document", async () => {
    // v1 is a single self-contained HTML file: a CSP that forbids inline content
    // breaks every page kept hosts. The isolation that matters comes from the
    // per-slug origin, not from sanitising the user's own body.
    const inline = `<!doctype html><html><head><style>body{background:#fff}</style></head><body><script>document.title="ok"</script></body></html>`;
    await seedSite("hdr-inline", {}, inline);

    const response = await dispatch(requestFor("hdr-inline"));
    const csp = response.headers.get("content-security-policy") ?? "";
    const text = await response.text();

    expect(text, "the inline document must be served byte-for-byte").toBe(inline);
    if (csp.includes("script-src")) {
      expect(csp, "script-src must permit the page's own inline script").toMatch(/script-src[^;]*'unsafe-inline'/);
    }
    if (csp.includes("style-src")) {
      expect(csp, "style-src must permit the page's own inline style").toMatch(/style-src[^;]*'unsafe-inline'/);
    }
  });

  it("gives kept's own system pages a stricter CSP than user content", async () => {
    const user = await dispatch(requestFor("hdr-live"));
    const system = await dispatch(requestFor("hdr-never-published"));

    const userCsp = user.headers.get("content-security-policy") ?? "";
    const systemCsp = system.headers.get("content-security-policy") ?? "";

    expect(systemCsp, "system pages must carry their own CSP").toBeTruthy();
    expect(
      systemCsp,
      "kept's own markup has no reason to permit what user content must be allowed, so the two policies must differ",
    ).not.toBe(userCsp);
  });

  it("gives the 304 the USER-PAGE CSP, not the strict system one", async () => {
    // The one place the obvious answer is wrong, and the reason it is wrong is
    // invisible from the response itself.
    //
    // A 304 carries no body, so `kind: "kept-own"` looks like the tidy choice —
    // there is no user content in it to permit. But a cache UPDATES ITS STORED
    // HEADERS from a 304's, so the strict `default-src 'none'` policy would be
    // written back onto the user's page already sitting in the browser cache and
    // break it on the next view. The page would work on first load and break on
    // reload, which is close to undiagnosable in the wild.
    //
    // Nothing about the 304 shows this: it is bodyless, its status is right, and
    // every other header would still be correct. Only comparing it against the
    // 200 it revalidates catches a regression here.
    const live = await dispatch(requestFor("hdr-live"));

    // MUST be cold. The Cache API answers a conditional against a stored entry
    // itself, synthesising a 304 that carries the STORED 200's headers — so a
    // warm request reports the right CSP no matter what the Worker's own 304
    // branch does, and this test would pass while the bug shipped. Evicting
    // forces the request down to `fetchObject`, whose `notModified` outcome is
    // the branch actually under test. (Verified by mutation: with the eviction
    // removed, flipping the branch to `kept-own` still passes.)
    await evictFromCache(requestFor("hdr-live"));

    const notModified = await dispatch(
      requestFor("hdr-live", "/", { headers: { "If-None-Match": liveEtag } }),
    );
    const system = await dispatch(requestFor("hdr-never-published"));

    expect(notModified.status, `expected a Worker-built 304, got ${describeResponse(notModified)}`).toBe(304);
    expect(
      notModified.headers.get("content-security-policy"),
      "a cache overwrites its stored headers from the 304, so the 304 must carry the SAME CSP as the 200 it revalidates — anything else retroactively re-applies a different policy to the page already in the browser's cache",
    ).toBe(live.headers.get("content-security-policy"));
    expect(
      notModified.headers.get("content-security-policy"),
      "and must specifically NOT be the strict kept-own policy, which would break every inline <style>/<script> the page depends on",
    ).not.toBe(system.headers.get("content-security-policy"));
  });

  it("does not conflict with the task 005 Cache-Control policy", async () => {
    const live = await dispatch(requestFor("hdr-live"));
    const suspended = await dispatch(requestFor("hdr-suspended"));

    expect(live.headers.get("cache-control"), "the header builder must not overwrite the live cache policy").toBe(
      "public, max-age=60, s-maxage=31536000",
    );
    expect(suspended.headers.get("cache-control"), "the header builder must not overwrite no-store").toBe("no-store");
  });
});
