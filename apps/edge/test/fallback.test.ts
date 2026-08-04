// R2 fallback on a KV miss — first-read-after-publish consistency (task 007).
//
// KV is eventually consistent: E04 writes Postgres, then R2, then KV, and the
// person who just published is the single most likely visitor to arrive inside
// KV's propagation window. On a TRUE KV miss the Worker probes R2 once for a
// slug-addressable pointer (`slugs/{slug}.json`, whose body is identical to the
// KV manifest value) before falling through to the branded 404.
//
// The two claims that only a read counter can prove:
//   - with a KV entry present the pointer is NEVER read (a probe on every
//     request would double the R2 bill for no benefit);
//   - a malformed KV value does NOT trigger the probe (it is not a miss — the
//     control plane wrote something, and re-deriving a manifest from a stale
//     pointer would resurrect a page the write path is mid-way through changing).
//
// The active group below is true today and must stay true: with no pointer
// seeded, every path returns exactly what it returned before task 007.

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { FALLBACK_CACHE_CONTROL, LIVE_CACHE_CONTROL } from "../src/cache";
import {
  countingEnv,
  describeCounts,
  evictFromCache,
  describeResponse,
  dispatchText,
  pageHtml,
  pointerKey,
  requestFor,
  seedPointerOnly,
  seedRawManifest,
  seedSite,
  SYSTEM_PAGE_TITLES,
} from "./fixtures";

describe("no pointer object present — behaviour is unchanged", () => {
  beforeAll(async () => {
    await seedSite("fb-published");
    await seedRawManifest("fb-malformed", "{ not json");
  });

  it("serves a normally published page", async () => {
    const { response, text } = await dispatchText(requestFor("fb-published"));

    expect(response.status, `expected 200, got ${describeResponse(response, text)}`).toBe(200);
    expect(text, "a KV hit must serve the page it points at").toBe(pageHtml("fb-published"));
  });

  it("404s a slug with neither a KV entry nor a pointer", async () => {
    const { response, text } = await dispatchText(requestFor("fb-nothing-anywhere"));

    expect(response.status, `expected the branded 404, got ${describeResponse(response, text)}`).toBe(404);
    expect(text, "nothing published anywhere must render the branded notFound page").toContain(
      SYSTEM_PAGE_TITLES.notFound,
    );
  });

  it("404s a malformed KV value without a 5xx", async () => {
    const { response, text } = await dispatchText(requestFor("fb-malformed"));

    expect(response.status, `expected the branded 404, got ${describeResponse(response, text)}`).toBe(404);
    expect(text, "a half-written manifest must render the branded notFound page").toContain(
      SYSTEM_PAGE_TITLES.notFound,
    );
  });
});

describe("KV miss → single R2 pointer probe (task 007)", () => {
  beforeAll(async () => {
    await seedPointerOnly("fb-pointer-only");
    await seedPointerOnly("fb-pointer-suspended", { status: "under_review" });
    await seedSite("fb-kv-present");
    await seedSite("fb-kv-policy");
    await seedRawManifest("fb-malformed-kv", "{ not json");
    // A pointer for the malformed slug too: if the probe fired on a parse
    // failure it would find this and wrongly serve, which is the bug this
    // fixture exists to catch.
    await seedPointerOnly("fb-malformed-kv");
    await env.KEPT_R2.put(pointerKey("fb-pointer-garbage"), "{ not json either");
  });

  it("serves the page from the pointer when KV has nothing", async () => {
    const { env: counted, counts } = countingEnv();
    // Explicitly cold — see `evictFromCache`. A cache hit here would report zero
    // reads and make the fallback budget below vacuous.
    await evictFromCache(requestFor("fb-pointer-only"));
    const { response, text } = await dispatchText(requestFor("fb-pointer-only"), counted);

    expect(response.status, `the pointer must cover KV's propagation window, got ${describeResponse(response, text)}`).toBe(200);
    expect(text, "the fallback must serve the same bytes the KV path would have").toBe(pageHtml("fb-pointer-only"));
    expect(counts.kvGet, `still exactly one KV read — ${describeCounts(counts)}`).toBe(1);
    expect(
      counts.r2Get,
      `the fallback budget is at most two R2 reads: the pointer probe and the object — ${describeCounts(counts)}`,
    ).toBe(2);
    expect(counts.r2Keys[0], "the probe key is `slugs/{slug}.json`").toBe(pointerKey("fb-pointer-only"));
  });

  it("caches a pointer-served page for a minute, not for a year", async () => {
    // A pointer-derived manifest is PROVISIONAL — it was read from R2 precisely
    // because KV had not caught up. Storing it under the year-long
    // `LIVE_CACHE_CONTROL` would freeze the older of the two copies at the edge,
    // including one caught mid-status-flip, and purge-by-URL is the only way
    // back out. The KV path takes over within `MANIFEST_KV_CACHE_TTL_SECONDS`,
    // so the entry only needs to survive that long.
    //
    // Nothing about the served page reveals which path produced it, so this is
    // the only assertion that can tell the two apart.
    //
    // `fb-kv-policy` is this test's own slug rather than a sibling's: dispatching
    // a URL leaves an entry in the Cache API, which is NOT rolled back between
    // tests, and the read-count assertions below must not end up measuring this
    // test's leftovers.
    const { response } = await dispatchText(requestFor("fb-pointer-only"));
    const viaKv = await dispatchText(requestFor("fb-kv-policy"));

    expect(
      response.headers.get("cache-control"),
      "a provisional, pointer-derived page must carry the short edge TTL",
    ).toBe(FALLBACK_CACHE_CONTROL);
    expect(
      response.headers.get("cache-control"),
      "and must NOT be cached like an authoritative KV-derived page — a year-long entry for a manifest KV has not confirmed is a purge away from being unfixable",
    ).not.toBe(viaKv.response.headers.get("cache-control"));
    expect(
      viaKv.response.headers.get("cache-control"),
      "fixture sanity: the KV path is still the year-long policy",
    ).toBe(LIVE_CACHE_CONTROL);
  });

  it("runs the normal status branch on a pointer-derived manifest", async () => {
    const { response, text } = await dispatchText(requestFor("fb-pointer-suspended"));

    expect(response.status, `a suspended pointer must still be 451, got ${describeResponse(response, text)}`).toBe(451);
    expect(text, "the fallback must not bypass moderation").toContain(SYSTEM_PAGE_TITLES.suspended);
  });

  it("never reads the pointer when a KV entry exists", async () => {
    const { env: counted, counts } = countingEnv();
    // Explicitly cold. Without this the request could be answered from a cache
    // entry a sibling test left behind, report 0 KV + 0 R2, and pass for the
    // wrong reason — it would prove the cache works, not that the probe is
    // skipped. See the note on `evictFromCache`.
    await evictFromCache(requestFor("fb-kv-present"));
    const { response } = await dispatchText(requestFor("fb-kv-present"), counted);

    expect(response.status, `expected 200, got ${describeResponse(response)}`).toBe(200);
    expect(counts.r2Get, `a KV hit must cost exactly one R2 read — ${describeCounts(counts)}`).toBe(1);
    expect(
      counts.r2Keys.some((key) => key.startsWith("slugs/")),
      `the pointer must never be probed on a KV hit — ${describeCounts(counts)}`,
    ).toBe(false);
  });

  it("does not probe on a malformed KV value — that is not a miss", async () => {
    const { env: counted, counts } = countingEnv();
    await evictFromCache(requestFor("fb-malformed-kv")); // explicitly cold
    const { response, text } = await dispatchText(requestFor("fb-malformed-kv"), counted);

    expect(response.status, `a malformed manifest must still be the branded 404, got ${describeResponse(response, text)}`).toBe(404);
    expect(
      counts.r2Keys.some((key) => key.startsWith("slugs/")),
      `a safeParse failure must NOT trigger the probe, even though a pointer exists for this slug — ${describeCounts(counts)}`,
    ).toBe(false);
  });

  it("falls through to the branded 404 when the pointer itself is unparseable", async () => {
    const { env: counted, counts } = countingEnv();
    await evictFromCache(requestFor("fb-pointer-garbage")); // explicitly cold
    const { response, text } = await dispatchText(requestFor("fb-pointer-garbage"), counted);

    expect(response.status, `an unparseable pointer must be a branded 404, got ${describeResponse(response, text)}`).toBe(404);
    expect(text, "an unparseable pointer must render the branded notFound page").toContain(
      SYSTEM_PAGE_TITLES.notFound,
    );
    expect(counts.r2Get, `one probe, no retry, no list — ${describeCounts(counts)}`).toBe(1);
  });

  it("probes exactly once — no retry, no list — when the pointer is absent", async () => {
    const { env: counted, counts } = countingEnv();
    await evictFromCache(requestFor("fb-nothing-at-all")); // explicitly cold
    const { response } = await dispatchText(requestFor("fb-nothing-at-all"), counted);

    expect(response.status, `expected the branded 404, got ${describeResponse(response)}`).toBe(404);
    expect(counts.r2Get, `exactly one probe on a total miss — ${describeCounts(counts)}`).toBe(1);
    expect(counts.otherCalls, "no `list` and no `head` — the probe is a single `get`").toEqual([]);
  });

  it("never probes for a slug that failed host resolution", async () => {
    const { env: counted, counts } = countingEnv();
    await dispatchText(requestFor("x".repeat(64)), counted);

    expect(counts.r2Get, `an invalid label must never reach R2 — ${describeCounts(counts)}`).toBe(0);
  });
});
