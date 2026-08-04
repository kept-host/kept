// The read-only charter: the serve path never writes (tasks 005 and 007).
//
// THE HARD ARCHITECTURE RULE OF THIS EPIC IS ONE-DIRECTIONAL. The control plane
// writes R2 and KV; `apps/edge` only reads them. Everything else in the design
// leans on that: a dashboard, database or `apps/web` outage cannot take a hosted
// page offline precisely because serving a page consists of two `get`s and
// nothing else. Freshness comes from an explicit purge-by-URL the WRITE side
// fires — never from the Worker deciding to fix up a store.
//
// Nothing failed if that broke. Every other file in this suite asserts what the
// Worker RETURNS, and a stray `KEPT_KV.put` to "repair" a manifest, an
// `R2.put` to backfill a pointer, or a `caches.default.delete` to self-purge
// would change no status, no header and no byte of any response. The suite
// would stay green while the epic's premise quietly stopped being true.
//
// So this file measures the stores instead of the response, two ways at once:
//
//   1. `counts.otherCalls` — the counting proxy records EVERY method touched on
//      either binding, so anything that is not `get`/`getWithMetadata` shows up
//      by name. That catches a write made through the bindings the Worker was
//      handed.
//   2. A full before/after inventory of both stores, taken with the real
//      bindings outside the counted env — KV keys AND their values, R2 keys AND
//      their etag/size. That catches a write the counter could miss (a write
//      through a binding reference the proxy never wrapped) and, unlike the
//      counter, notices an in-place OVERWRITE of an existing key.
//
// LIMIT, STATED PLAINLY: an outbound `fetch` — a Cloudflare purge-by-URL call,
// or a call back to the control plane — is not observable from inside the test
// without stubbing the global, which this repo does not do. The purge surface
// that IS observable is the Cache API, and it is asserted below.

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
  countingEnv,
  describeCounts,
  describeResponse,
  dispatch,
  dispatchText,
  evictFromCache,
  objectKey,
  requestFor,
  seedPointerOnly,
  seedSite,
  type StoreCounts,
} from "./fixtures";

/**
 * Everything currently in both stores, in a comparable shape.
 *
 * Values are included, not just key names: a manifest rewritten in place under
 * the same key is a write, and a key-only listing would call it unchanged. R2
 * uses `etag` + `size` for the same reason without pulling every body into
 * memory.
 */
interface StoreInventory {
  kv: string[];
  r2: string[];
}

async function inventory(): Promise<StoreInventory> {
  const kvList = await env.KEPT_KV.list();
  expect(
    kvList.list_complete,
    "the KV fixture set outgrew one list page — this inventory would compare partial views and stop detecting writes",
  ).toBe(true);

  const kv: string[] = [];
  for (const key of kvList.keys) {
    kv.push(`${key.name}=${await env.KEPT_KV.get(key.name, { type: "text" })}`);
  }

  const r2List = await env.KEPT_R2.list();
  expect(
    r2List.truncated,
    "the R2 fixture set outgrew one list page — this inventory would compare partial views and stop detecting writes",
  ).toBe(false);

  const r2 = r2List.objects.map((object) => `${object.key}=${object.etag}:${object.size}`);

  return { kv: kv.sort(), r2: r2.sort() };
}

/** Assert one request performed reads and nothing else. */
function expectReadsOnly(label: string, counts: StoreCounts, before: StoreInventory, after: StoreInventory): void {
  expect(
    counts.otherCalls,
    `${label} touched a non-read method on a store binding. The serve path may call only KEPT_KV.get and KEPT_R2.get — every write belongs to the control plane. ${describeCounts(counts)}`,
  ).toEqual([]);
  expect(
    after.kv,
    `${label} changed the KV namespace. The Worker must never write, delete or repair a manifest — the KV manifest is the control plane's to own.`,
  ).toEqual(before.kv);
  expect(
    after.r2,
    `${label} changed the R2 bucket. The Worker must never upload, backfill a slugs/ pointer, or delete an object.`,
  ).toEqual(before.r2);
}

describe("serving performs reads only — never a write, never a store delete", () => {
  let liveEtag = "";

  beforeAll(async () => {
    const live = await seedSite("ro-live");
    await seedSite("ro-suspended", { status: "under_review" });
    await seedPointerOnly("ro-pointer-only");

    const head = await env.KEPT_R2.head(objectKey(live));
    if (head === null) throw new Error(`fixture not seeded: ${objectKey(live)}`);
    liveEtag = head.httpEtag;
  });

  it("proves the inventory actually detects a write, so the assertions below are not vacuous", async () => {
    // Without this, `inventory()` returning a constant would make every test in
    // this file pass forever. All three shapes of write are checked, because
    // each is a different way the charter could break.
    const before = await inventory();

    await env.KEPT_KV.put("ro-detector", JSON.stringify({ any: "value" }));
    expect(
      (await inventory()).kv,
      "a new KV key must be visible to the inventory",
    ).not.toEqual(before.kv);

    await env.KEPT_KV.put("ro-detector", JSON.stringify({ any: "other value" }));
    const overwritten = await inventory();
    await env.KEPT_KV.put("ro-detector", JSON.stringify({ any: "value" }));
    expect(
      (await inventory()).kv,
      "an in-place OVERWRITE of an existing key must be visible too — this is the one a key-only listing would miss",
    ).not.toEqual(overwritten.kv);

    await env.KEPT_R2.put("ro-detector-object", "bytes");
    expect(
      (await inventory()).r2,
      "a new R2 object must be visible to the inventory",
    ).not.toEqual(before.r2);
  });

  it("serves a live page with reads only", async () => {
    const { env: counted, counts } = countingEnv();
    // Cold, deliberately: a cache hit costs zero store operations and would make
    // "no writes happened" true for the wrong reason. The Cache API is not
    // rolled back between tests, so this has to be explicit.
    await evictFromCache(requestFor("ro-live"));

    const before = await inventory();
    const { response, text } = await dispatchText(requestFor("ro-live"), counted);
    const after = await inventory();

    expect(response.status, `fixture sanity: expected 200, got ${describeResponse(response, text)}`).toBe(200);
    expect(counts.kvGet, `the cold budget is one KV read — ${describeCounts(counts)}`).toBe(1);
    expect(counts.r2Get, `and one R2 read — ${describeCounts(counts)}`).toBe(1);
    expectReadsOnly("serving a live page", counts, before, after);
  });

  it("serves the branded 404 with reads only", async () => {
    // The tempting place to write: a slug that resolves to nothing is exactly
    // where a "let me cache a negative manifest" optimisation would land.
    const { env: counted, counts } = countingEnv();
    await evictFromCache(requestFor("ro-never-published"));

    const before = await inventory();
    const { response, text } = await dispatchText(requestFor("ro-never-published"), counted);
    const after = await inventory();

    expect(response.status, `fixture sanity: expected 404, got ${describeResponse(response, text)}`).toBe(404);
    expectReadsOnly("serving the branded 404", counts, before, after);
  });

  it("serves a branded system page with reads only", async () => {
    const { env: counted, counts } = countingEnv();
    await evictFromCache(requestFor("ro-suspended"));

    const before = await inventory();
    const { response, text } = await dispatchText(requestFor("ro-suspended"), counted);
    const after = await inventory();

    expect(response.status, `fixture sanity: expected 451, got ${describeResponse(response, text)}`).toBe(451);
    expect(counts.r2Get, `a suspended page never reaches R2 at all — ${describeCounts(counts)}`).toBe(0);
    expectReadsOnly("serving the suspended page", counts, before, after);
  });

  it("answers a conditional request with reads only", async () => {
    // Cold on purpose: warm, the Cache API synthesises the 304 itself and the
    // Worker's own conditional branch — the one that calls R2 with `onlyIf` —
    // never runs, so this would measure nothing.
    const { env: counted, counts } = countingEnv();
    await evictFromCache(requestFor("ro-live"));

    const before = await inventory();
    const response = await dispatch(
      requestFor("ro-live", "/", { headers: { "If-None-Match": liveEtag } }),
      counted,
    );
    const after = await inventory();

    expect(response.status, `fixture sanity: expected a Worker-built 304, got ${describeResponse(response)}`).toBe(304);
    expectReadsOnly("answering a conditional request", counts, before, after);
  });

  it("serves a pointer-fallback page with reads only — it does not backfill KV", async () => {
    // THE ONE THAT WOULD ACTUALLY BE WRITTEN BY SOMEBODY. The fallback fires
    // because KV has not caught up, and "while we're here, write the manifest
    // into KV so the next request is cheap" is a genuinely attractive idea. It
    // is also a serve-path write that races the control plane's own write and
    // can resurrect a manifest the write side is mid-way through changing —
    // which is why the ordering obligation lives on the write side alone.
    const { env: counted, counts } = countingEnv();
    await evictFromCache(requestFor("ro-pointer-only"));

    const before = await inventory();
    const { response, text } = await dispatchText(requestFor("ro-pointer-only"), counted);
    const after = await inventory();

    expect(response.status, `fixture sanity: expected the fallback to serve 200, got ${describeResponse(response, text)}`).toBe(
      200,
    );
    expect(counts.kvGet, `the fallback still costs one KV read — ${describeCounts(counts)}`).toBe(1);
    expect(counts.r2Get, `plus the pointer probe and the object — ${describeCounts(counts)}`).toBe(2);
    expectReadsOnly("serving through the pointer fallback", counts, before, after);
  });

  it("never purges its own edge-cache entry", async () => {
    // The only purge surface reachable from inside the Worker is the Cache API,
    // and purging is the WRITE side's job (purge-by-URL on
    // publish/replace/rename/demote/suspend/delete). A serve path that deleted
    // its own entry would silently turn the year-long `s-maxage` into no
    // caching at all: every response would still be correct, and the cost model
    // the whole epic is built on would be gone.
    //
    // Verified by mutation against a delete on the LOOKUP path — the shape that
    // survives a cache hit, since a hit returns before `storeResponse` can put
    // the entry back. A delete scheduled into `waitUntil` alongside the put is
    // NOT deterministically detectable (the two promises race), so this test
    // does not claim to catch that one.
    const request = requestFor("ro-live");
    await evictFromCache(request);

    await dispatch(request);
    const stored = await caches.default.match(request);
    expect(stored, "the first request must populate the cache — otherwise the check below proves nothing").toBeTruthy();

    await dispatch(request);
    expect(
      await caches.default.match(request),
      "serving a second time must leave the cached entry in place. Invalidation is the control plane's purge-by-URL, never something the serve path does to itself.",
    ).toBeTruthy();
  });
});
