// A store that FAILS, as opposed to a store that is simply empty (tasks 003/007).
//
// `manifest.ts` and `r2.ts` both distinguish "the binding answered, and the
// answer was nothing" from "the binding never answered at all". The visitor sees
// the same branded page either way — that identity is itself asserted below —
// but the two events take DIFFERENT internal paths, and getting that wrong is
// invisible from the outside. It has already cost this epic once: collapsing
// every throw into a bare `missing` is what let a `TypeError` from a quoted
// `If-None-Match` masquerade as "page deleted" on every conditional request.
//
// So the distinction is worth a test, and the test is only honest if the store
// error is REAL:
//
//   - KV throws `414 ... exceeds key length limit` on a key over 512 bytes.
//   - R2 throws `The specified object name is not valid. (10020)` on an object
//     name over 1024 bytes.
//
// Both are the genuine local bindings failing at their genuine documented
// limits. NOTHING HERE IS INJECTED, STUBBED OR PATCHED — a throwing stand-in
// would prove only that the stand-in throws, whereas these prove the Worker
// survives the real error shape the real store produces.

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { resolveManifest } from "../src/manifest";
import {
  countingEnv,
  describeCounts,
  describeResponse,
  dispatchText,
  evictFromCache,
  manifest,
  objectKey,
  pointerKey,
  requestFor,
  seedManifest,
  seedObject,
  seedSite,
  SYSTEM_PAGE_TITLES,
} from "./fixtures";

/**
 * A slug past KV's 512-byte key limit, so `KEPT_KV.get` throws for real.
 *
 * `resolveHost` caps a label at 63 characters, so this can never arrive over
 * HTTP — which is exactly why `resolveManifest` is exercised directly here. The
 * function's contract ("a binding failure is a miss, and a miss probes") is what
 * is under test; the label guard that keeps such a slug off the wire has its own
 * coverage in `host-resolution.test.ts`.
 */
const KV_FAILING_SLUG = "k".repeat(600);

describe("a KV binding failure is a miss, and a miss probes the pointer (task 007)", () => {
  it("throws for real on an over-long key, rather than returning null", async () => {
    // The premise of the two tests below. If a future runtime started answering
    // `null` here instead of throwing, they would still pass while measuring the
    // ordinary empty-key path — this test is what stops that.
    await expect(
      env.KEPT_KV.get(KV_FAILING_SLUG, { type: "text" }),
      "the KV binding must genuinely throw on an over-long key, otherwise this file tests nothing",
    ).rejects.toThrow();
  });

  it("serves from the pointer when KV cannot answer at all", async () => {
    const m = manifest({ siteId: "site-kv-outage" });
    await seedObject(m, "<p>served through a KV outage</p>");
    await env.KEPT_R2.put(pointerKey(KV_FAILING_SLUG), JSON.stringify(m));

    const lookup = await resolveManifest(env.KEPT_KV, env.KEPT_R2, KV_FAILING_SLUG);

    expect(
      lookup.kind,
      `a KV OUTAGE is the case the pointer exists for — R2 is still up and holds the only remaining copy of the manifest. Got ${JSON.stringify(lookup)}`,
    ).toBe("manifest");
    expect(
      lookup.kind === "manifest" ? lookup.source : null,
      "the manifest must be reported as pointer-derived, so `index.ts` gives it the short edge TTL",
    ).toBe("pointer");
    expect(
      lookup.kind === "manifest" ? lookup.manifest.siteId : null,
      "the pointer's own manifest must be the one returned",
    ).toBe("site-kv-outage");
  });

  it("is unservable — not a throw — when KV fails and no pointer exists", async () => {
    const lookup = await resolveManifest(env.KEPT_KV, env.KEPT_R2, `${KV_FAILING_SLUG}-nopointer`);

    expect(
      lookup.kind,
      "a failed KV read with nothing in R2 either must resolve to a value the caller can render, never a rejected promise",
    ).toBe("unservable");
  });
});

/**
 * An R2 object name past R2's 1024-byte limit, reached over HTTP.
 *
 * `MAX_REQUEST_PATH_BYTES` bounds the *request path* at 1024 bytes and R2 bounds
 * the *object name* at 1024 bytes — but the key is `sites/{siteId}/{versionId}/`
 * plus that path, so a path in the narrow band just under the cap builds a key
 * just over it. The store call then throws. This is the only `storeError` in
 * `r2.ts` reachable from the wire, which makes it the right way to prove the
 * branch renders a branded page rather than a 500.
 */
const R2_ERROR_SLUG = "r2-store-error";
const OVER_LONG_PATH = `/${"p".repeat(1020)}`;

describe("an R2 store error renders the same branded page as a missing object (task 003)", () => {
  beforeAll(async () => {
    await seedSite(R2_ERROR_SLUG);
    // A manifest pointing at an object that was never written — the `notFound`
    // half of the comparison.
    const absent = manifest({ siteId: "site-r2-absent" });
    await seedManifest("r2-absent-object", absent);
  });

  it("throws for real on an over-long object name, rather than returning null", async () => {
    await expect(
      env.KEPT_R2.get(`sites/site-${R2_ERROR_SLUG}/v1${OVER_LONG_PATH}`),
      "the R2 binding must genuinely throw on an over-long object name, otherwise this file tests nothing",
    ).rejects.toThrow();
  });

  it("answers a failed R2 read with the branded 404 and never a 5xx", async () => {
    const { env: counted, counts } = countingEnv();
    // Explicitly cold — the Cache API is not rolled back between tests, and a
    // hit would report zero R2 reads and make the budget assertion vacuous.
    await evictFromCache(requestFor(R2_ERROR_SLUG, OVER_LONG_PATH));
    const { response, text } = await dispatchText(requestFor(R2_ERROR_SLUG, OVER_LONG_PATH), counted);

    expect(
      response.status,
      `a store failure must be a branded 404, never a 500 — a thrown binding error escaping to the visitor is the exact failure this epic exists to make impossible. Got ${describeResponse(response, text)}`,
    ).toBe(404);
    expect(text, "the failed read must render the branded notFound page").toContain(
      SYSTEM_PAGE_TITLES.notFound,
    );
    expect(text, "a store error must never leak the key, the bucket or a stack trace").not.toContain("sites/");
    expect(
      counts.r2Get,
      `a store error must not be retried — the budget is still one R2 operation — ${describeCounts(counts)}`,
    ).toBe(1);
  });

  it("is byte-identical to the response for an object that simply is not there", async () => {
    // `MissingReason` exists so the two events can be told apart in the LOGS.
    // It must never become a difference the visitor can see: a page that failed
    // to load and a page that was purged have to be indistinguishable, or the
    // reason field turns into an information leak.
    const failed = await dispatchText(requestFor(R2_ERROR_SLUG, OVER_LONG_PATH));
    const absent = await dispatchText(requestFor("r2-absent-object"));

    expect(
      absent.response.status,
      `the notFound half must also be 404, got ${describeResponse(absent.response, absent.text)}`,
    ).toBe(404);
    expect(
      failed.text,
      "storeError and notFound must render the same bytes — the distinction is for our logs, not for the visitor",
    ).toBe(absent.text);
    expect(
      failed.response.headers.get("cache-control"),
      "and the same cache policy, so a store blip is not cached any differently from a real miss",
    ).toBe(absent.response.headers.get("cache-control"));
  });

  it("still serves the same slug normally at its real path", async () => {
    // Guards against the cheap way to pass the test above: rejecting the whole
    // slug. The over-long path must fail, and nothing else about it may.
    const m = manifest({ siteId: `site-${R2_ERROR_SLUG}` });
    const { response } = await dispatchText(requestFor(R2_ERROR_SLUG));

    expect(response.status, "the ordinary path of the same site must be unaffected").toBe(200);
    expect(await env.KEPT_R2.head(objectKey(m)), "fixture sanity: the real object exists").not.toBeNull();
  });
});
