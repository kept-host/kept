// E10 D6 — `/_kept/readme`: a kept page's README, served by the Worker only while
// the manifest's badge says the page has one (Q6). Real KV, real R2.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { BadgeData, KvManifest } from "@kept/shared";

import { LIVE_CACHE_CONTROL } from "../src/cache";
import {
  countingEnv,
  describeCounts,
  describeResponse,
  dispatchText,
  evictFromCache,
  manifest,
  requestFor,
  seedManifest,
  seedObject,
  SYSTEM_PAGE_TITLES,
} from "./fixtures";

const WITH_README: BadgeData = { variant: "kept", style: "standard", readme: true };
const README = "<!doctype html><html><head><style>h1{color:#333}</style></head><body><h1>How it was made</h1></body></html>";

function readmeKey(m: KvManifest): string {
  return `sites/${m.siteId}/_kept/readme.html`;
}

async function seedReadmeSite(
  slug: string,
  overrides: Partial<KvManifest> = {},
  withObject = true,
): Promise<KvManifest> {
  const m = manifest({ siteId: `site-${slug}`, badge: WITH_README, ...overrides });
  await seedObject(m, "<body>page</body>");
  if (withObject) await env.KEPT_R2.put(readmeKey(m), README);
  await seedManifest(slug, m);
  return m;
}

async function cold(slug: string, path = "/_kept/readme", init?: RequestInit, testEnv = env) {
  const request = requestFor(slug, path, init);
  await evictFromCache(request);
  return dispatchText(request, testEnv);
}

describe("/_kept/readme", () => {
  it("serves the README as kept's own page: strict CSP, HTML, no badge, page cache policy", async () => {
    const slug = "readme-ok";
    const m = await seedReadmeSite(slug);
    const { env: counted, counts } = countingEnv();
    const { response, text } = await cold(slug, "/_kept/readme", undefined, counted);

    expect(response.status, describeResponse(response, text)).toBe(200);
    expect(text).toBe(README);
    expect(text).not.toContain("<kept-badge>");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe(LIVE_CACHE_CONTROL);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp, "the README's inline <style> is allowed").toContain("style-src 'unsafe-inline'");
    expect(csp, "no script on kept's own page").not.toContain("script-src");
    expect(counts.kvGet, describeCounts(counts)).toBe(1);
    expect(counts.r2Get, describeCounts(counts)).toBe(1);
    expect(counts.r2Keys).toEqual([readmeKey(m)]);
  });

  it("304s on its own ETag", async () => {
    const slug = "readme-304";
    await seedReadmeSite(slug);
    const etag = (await cold(slug)).response.headers.get("etag") ?? "";
    const { response } = await cold(slug, "/_kept/readme", { headers: { "If-None-Match": etag } });
    expect(response.status).toBe(304);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("is the branded 404 when the flag is absent, without reading R2", async () => {
    const slug = "readme-noflag";
    await seedReadmeSite(slug, { badge: { variant: "kept", style: "standard" } });
    const { env: counted, counts } = countingEnv();
    const { response, text } = await cold(slug, "/_kept/readme", undefined, counted);
    expect(response.status).toBe(404);
    expect(text).toContain(SYSTEM_PAGE_TITLES.notFound);
    expect(counts.r2Get, describeCounts(counts)).toBe(0);
  });

  it("is the branded 404 on a manifest with no badge at all", async () => {
    const slug = "readme-nobadge";
    await seedReadmeSite(slug, { badge: undefined });
    const { response } = await cold(slug);
    expect(response.status).toBe(404);
  });

  it("is the branded 404 when the flag is set but the object is missing", async () => {
    const slug = "readme-missing";
    await seedReadmeSite(slug, {}, false);
    const { response, text } = await cold(slug);
    expect(response.status).toBe(404);
    expect(text).toContain(SYSTEM_PAGE_TITLES.notFound);
  });

  for (const path of ["/_kept/other", "/_kept/readme.html", "/_kept/readme/", "/_kept/"]) {
    it(`any other /_kept/* path (${path}) is the branded 404 without reading R2`, async () => {
      const slug = "readme-other";
      await seedReadmeSite(slug);
      const { env: counted, counts } = countingEnv();
      const { response, text } = await cold(slug, path, undefined, counted);
      expect(response.status).toBe(404);
      expect(text).toContain(SYSTEM_PAGE_TITLES.notFound);
      expect(counts.r2Get, describeCounts(counts)).toBe(0);
    });
  }

  it("other statuses keep their system pages", async () => {
    const slug = "readme-expired";
    await seedReadmeSite(slug, { status: "expired" });
    const { response, text } = await cold(slug);
    expect(response.status).toBe(410);
    expect(text).toContain(SYSTEM_PAGE_TITLES.expired);
  });
});
