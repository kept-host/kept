// E10 D10 (Q1) — a retired handle's KV entry is a redirect, not a page: the
// Worker answers every path on the old host with a 301 to the same path on the
// current handle's host, before any R2 read. Real KV, real R2.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { KvRedirectManifest } from "@kept/shared";

import { SHORT_EDGE_CACHE_CONTROL } from "../src/cache";
import {
  BASE_DOMAIN,
  countingEnv,
  describeCounts,
  describeResponse,
  dispatchText,
  evictFromCache,
  pointerKey,
  requestFor,
  seedRawManifest,
  SYSTEM_PAGE_TITLES,
} from "./fixtures";

async function seedRedirect(slug: string, redirectTo: string): Promise<void> {
  const value: KvRedirectManifest = { redirectTo, updatedAt: 1_770_000_000_000 };
  await seedRawManifest(slug, JSON.stringify(value));
}

async function cold(slug: string, path: string, testEnv = env) {
  const request = requestFor(slug, path);
  await evictFromCache(request);
  return dispatchText(request, testEnv);
}

describe("old handle → current handle", () => {
  it("301s to the same path and query on the new host, with 1 KV and 0 R2 reads", async () => {
    await seedRedirect("old-handle", "new-handle");
    const { env: counted, counts } = countingEnv();
    const { response, text } = await cold("old-handle", "/posts/1?x=1&y=2", counted);

    expect(response.status, describeResponse(response, text)).toBe(301);
    expect(response.headers.get("location")).toBe(`https://new-handle.${BASE_DOMAIN}/posts/1?x=1&y=2`);
    expect(response.headers.get("cache-control")).toBe(SHORT_EDGE_CACHE_CONTROL);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(text).toBe("");
    expect(counts.kvGet, describeCounts(counts)).toBe(1);
    expect(counts.r2Get, describeCounts(counts)).toBe(0);
  });

  it("redirects the root", async () => {
    await seedRedirect("old-root", "new-root");
    const { response } = await cold("old-root", "/");
    expect(response.headers.get("location")).toBe(`https://new-root.${BASE_DOMAIN}/`);
  });

  for (const bad of ["evil.com", "a/b", "", "UPPER", "www", "-x", "x".repeat(64)]) {
    it(`refuses a redirectTo that is not a slug (${JSON.stringify(bad)})`, async () => {
      await seedRedirect("old-bad", bad);
      const { response, text } = await cold("old-bad", "/");
      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
      expect(text).toContain(SYSTEM_PAGE_TITLES.notFound);
    });
  }

  it("follows a redirect found through the KV-miss pointer", async () => {
    await env.KEPT_R2.put(
      pointerKey("old-pointer"),
      JSON.stringify({ redirectTo: "new-pointer", updatedAt: 1 }),
    );
    const { response } = await cold("old-pointer", "/a");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`https://new-pointer.${BASE_DOMAIN}/a`);
  });

  it("a value that is neither a page nor a redirect is the branded 404", async () => {
    await seedRawManifest("old-junk", JSON.stringify({ redirectTo: 5, updatedAt: 1 }));
    const { response } = await cold("old-junk", "/");
    expect(response.status).toBe(404);
  });
});
