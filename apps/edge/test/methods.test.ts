// Step 0 — the method gate (task 005).
//
// A static serving plane answers reads only. The gate runs ahead of host
// resolution, so an unsupported method is rejected before it can cost a KV read,
// an R2 read or a cache lookup — which is what stops a write-shaped flood
// against random subdomains from costing anything at all.

import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
  BASE_DOMAIN,
  countingEnv,
  describeCounts,
  describeResponse,
  dispatch,
  dispatchText,
  pageHtml,
  requestFor,
  seedSite,
} from "./fixtures";

const SLUG = "method-page";

describe("method handling", () => {
  beforeAll(async () => {
    await seedSite(SLUG);
  });

  it("serves GET with the page body", async () => {
    const { response, text } = await dispatchText(requestFor(SLUG));

    expect(response.status, `GET must serve, got ${describeResponse(response, text)}`).toBe(200);
    expect(text, "GET must return the seeded page").toBe(pageHtml(SLUG));
  });

  it("serves HEAD with the same status and headers as GET", async () => {
    const get = await dispatch(requestFor(SLUG));
    await get.text();
    const head = await dispatch(requestFor(SLUG, "/", { method: "HEAD" }));

    expect(head.status, `HEAD must answer like GET, got ${describeResponse(head)}`).toBe(get.status);
    for (const header of ["content-type", "etag", "cache-control"]) {
      expect(head.headers.get(header), `HEAD must carry the same ${header} as GET`).toBe(get.headers.get(header));
    }
  });

  it("returns no body for HEAD over the wire", async () => {
    // Asserted through `SELF` rather than a direct handler call: body stripping
    // for HEAD is the HTTP layer's job, and only `SELF` exercises it.
    const response = await SELF.fetch(`https://${SLUG}.${BASE_DOMAIN}/`, { method: "HEAD" });
    const text = await response.text();

    expect(response.status, `HEAD over the wire must be 200, got ${describeResponse(response, text)}`).toBe(200);
    expect(text, "a HEAD response must transfer no body").toBe("");
  });

  it("does not let a HEAD populate the cache for later GETs", async () => {
    const request = requestFor(SLUG, "/head-only.html", { method: "HEAD" });
    await dispatch(request);

    const entry = await caches.default.match(
      requestFor(SLUG, "/head-only.html"),
    );
    expect(
      entry,
      "the Cache API is GET-only; a stored HEAD would sit bodyless under a key GET requests would then hit",
    ).toBeUndefined();
  });

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    it(`rejects ${method} with 405 and an Allow header, at zero store cost`, async () => {
      const { env: counted, counts } = countingEnv();
      const response = await dispatch(requestFor(SLUG, "/", { method }), counted);

      expect(response.status, `${method} must be 405, got ${describeResponse(response)}`).toBe(405);
      expect(response.headers.get("allow"), `${method} must be answered with the methods that are allowed`).toBe(
        "GET, HEAD",
      );
      expect(counts.kvGet, `${method} must cost zero KV reads — ${describeCounts(counts)}`).toBe(0);
      expect(counts.r2Get, `${method} must cost zero R2 reads — ${describeCounts(counts)}`).toBe(0);
    });
  }

  it("rejects an unsupported method on a reserved label too, without redirecting", async () => {
    const { env: counted, counts } = countingEnv();
    const response = await dispatch(
      new Request(`https://www.${BASE_DOMAIN}/`, { method: "POST" }),
      counted,
    );

    expect(response.status, `the method gate runs ahead of host resolution, got ${describeResponse(response)}`).toBe(405);
    expect(counts.kvGet + counts.r2Get, `zero store reads — ${describeCounts(counts)}`).toBe(0);
  });

  it("never stores a 405 in the cache", async () => {
    // A path no other test in this file touches: the Cache API is not rolled
    // back between tests, so reusing `/` would measure a sibling's stored 200.
    const path = "/post-only.html";
    await dispatch(requestFor(SLUG, path, { method: "POST" }));

    expect(
      await caches.default.match(requestFor(SLUG, path)),
      "a 405 must not become a cache entry that later GETs would hit",
    ).toBeUndefined();
  });
});
