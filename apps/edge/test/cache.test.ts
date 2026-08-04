// Pipeline step 2 + 7 — the Cache API (task 005).
//
// THE READ-COUNT ASSERTION. Nothing observable at the HTTP layer distinguishes a
// cache hit from a miss: both return the same status, the same headers and the
// same bytes. The epic's central cost claim — "a hit costs zero KV and zero R2
// operations" — is therefore only checkable by counting the reads the Worker
// actually performs, which is what `countingEnv` exists for.
//
// `dispatch` awaits `waitOnExecutionContext`, so the `waitUntil` cache put from
// request 1 has landed before request 2 is issued. Without that this file would
// be a race dressed up as a test.

import { beforeAll, describe, expect, it } from "vitest";

import { LIVE_CACHE_CONTROL, NO_STORE_CACHE_CONTROL } from "../src/cache";
import {
  countingEnv,
  describeCounts,
  describeResponse,
  dispatch,
  dispatchText,
  pageHtml,
  requestFor,
  seedSite,
} from "./fixtures";

const SLUG = "cached-page";

/** Is this exact request URL in the edge cache right now? */
async function cachedEntry(request: Request): Promise<Response | undefined> {
  return caches.default.match(request);
}

describe("a cache hit skips both stores", () => {
  beforeAll(async () => {
    await seedSite(SLUG);
  });

  it("costs 1 KV + 1 R2 cold and 0 KV + 0 R2 warm, with identical bodies", async () => {
    const { env: counted, counts } = countingEnv();

    const cold = await dispatchText(requestFor(SLUG), counted);
    expect(cold.response.status, `cold request must serve the page, got ${describeResponse(cold.response, cold.text)}`).toBe(200);
    expect(counts.kvGet, `cold request budget is exactly 1 KV read — ${describeCounts(counts)}`).toBe(1);
    expect(counts.r2Get, `cold request budget is exactly 1 R2 read — ${describeCounts(counts)}`).toBe(1);

    const kvAfterCold = counts.kvGet;
    const r2AfterCold = counts.r2Get;

    const warm = await dispatchText(requestFor(SLUG), counted);
    expect(warm.response.status, `warm request must serve the page, got ${describeResponse(warm.response, warm.text)}`).toBe(200);
    expect(
      counts.kvGet - kvAfterCold,
      `a cache HIT must perform ZERO further KV reads — ${describeCounts(counts)}`,
    ).toBe(0);
    expect(
      counts.r2Get - r2AfterCold,
      `a cache HIT must perform ZERO further R2 reads — ${describeCounts(counts)}`,
    ).toBe(0);
    expect(warm.text, "a hit and a miss must return byte-identical bodies").toBe(cold.text);
    expect(warm.text, "the served body must be this slug's seeded page").toBe(pageHtml(SLUG));
    expect(
      warm.response.headers.get("content-type"),
      "a hit must return the stored Content-Type, not a re-derived one",
    ).toBe(cold.response.headers.get("content-type"));
    expect(warm.response.headers.get("etag"), "a hit must return the stored ETag").toBe(
      cold.response.headers.get("etag"),
    );
  });

  it("caches per URL, so a second path is still a cold request", async () => {
    const { env: counted, counts } = countingEnv();

    await dispatch(requestFor(SLUG, "/"), counted);
    const afterFirst = counts.r2Get;
    await dispatch(requestFor(SLUG, "/other.html"), counted);

    expect(
      counts.r2Get - afterFirst,
      `a different URL must miss the cache and pay its own R2 read — ${describeCounts(counts)}`,
    ).toBe(1);
  });
});

describe("cache policy per response class", () => {
  beforeAll(async () => {
    await seedSite("policy-live");
    await seedSite("policy-suspended", { status: "under_review" });
    await seedSite("policy-quarantined", { status: "quarantined" });
    await seedSite("policy-expired", { status: "expired" });
  });

  it("serves live content with max-age=60, s-maxage=31536000 and no stale-while-revalidate", async () => {
    const response = await dispatch(requestFor("policy-live"));
    const cacheControl = response.headers.get("cache-control");

    expect(cacheControl, `live Cache-Control mismatch on ${describeResponse(response)}`).toBe(LIVE_CACHE_CONTROL);
    expect(cacheControl, "the constant itself must stay the reviewed policy").toBe(
      "public, max-age=60, s-maxage=31536000",
    );
    expect(
      cacheControl,
      "NO stale-while-revalidate: a cached entry cannot tell an old copy from a taken-down one, so a moderation flip would be served through the revalidation window",
    ).not.toContain("stale-while-revalidate");
  });

  it("stores live content in the edge cache", async () => {
    const request = requestFor("policy-live");
    await dispatch(request);

    const entry = await cachedEntry(request);
    expect(entry, "live content must be present in the Cache API after the request").toBeDefined();
    expect(await entry?.text(), "the cached entry must hold the served bytes").toBe(pageHtml("policy-live"));
  });

  for (const slug of ["policy-suspended", "policy-quarantined"]) {
    it(`marks ${slug} no-store and keeps it out of the cache`, async () => {
      const request = requestFor(slug);
      const response = await dispatch(request);

      expect(response.status, `${slug} must be 451, got ${describeResponse(response)}`).toBe(451);
      expect(response.headers.get("cache-control"), `${slug} must be no-store — a cached quarantine is a moderation failure`).toBe(
        NO_STORE_CACHE_CONTROL,
      );
      expect(await cachedEntry(request), `${slug} must be ABSENT from the Cache API after the request`).toBeUndefined();
    });
  }

  it("marks an expired draft no-store and keeps it out of the cache", async () => {
    const request = requestFor("policy-expired");
    const response = await dispatch(request);

    expect(response.status, `expired must be 410, got ${describeResponse(response)}`).toBe(410);
    expect(response.headers.get("cache-control"), "expired must be no-store").toBe(NO_STORE_CACHE_CONTROL);
    expect(await cachedEntry(request), "expired must be ABSENT from the Cache API after the request").toBeUndefined();
  });

  it("gives notFound a short s-maxage so bot sweeps are bounded but a later publish is not shadowed", async () => {
    const request = requestFor("policy-never-published");
    const response = await dispatch(request);

    expect(response.status, `unknown slug must be 404, got ${describeResponse(response)}`).toBe(404);
    expect(
      response.headers.get("cache-control"),
      "notFound is edge-cached briefly (s-maxage=60) and never browser-cached (max-age=0)",
    ).toBe("public, max-age=0, s-maxage=60");
  });

  it("never stores a 304 revalidation as a cache entry", async () => {
    const live = await dispatch(requestFor("policy-live"));
    const etag = live.headers.get("etag");
    expect(etag, "the live page must carry an ETag to revalidate against").toBeTruthy();

    const conditional = requestFor("policy-live", "/", { headers: { "If-None-Match": etag as string } });
    const response = await dispatch(conditional);

    // The cache already holds the 200 from the request above; the assertion is
    // that the bodyless 304 did not overwrite it.
    const entry = await cachedEntry(requestFor("policy-live"));
    expect(response.status, `expected a 304 or a cache-hit 200, got ${describeResponse(response)}`).toBeLessThan(400);
    expect(entry, "the cache entry must still exist after a revalidation").toBeDefined();
    expect(await entry?.text(), "a 304 must never replace the cached entry with an empty body").toBe(
      pageHtml("policy-live"),
    );
  });
});
