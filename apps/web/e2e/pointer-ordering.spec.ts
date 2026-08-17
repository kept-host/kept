import { setTimeout as sleep } from "node:timers/promises";

import { test, expect } from "@playwright/test";

// The KV client is imported here — one of only three places outside
// `lib/storage/manifest.ts` — to DELETE A KEY BY HAND. That is the whole
// technique: the slug pointer is read only when KV cannot answer, so without a
// forced miss neither drill below observes anything at all. Nothing here writes
// a manifest through it (`eslint.config.mjs` exempts this file for that reason).
import { kvStore } from "../lib/storage/kv";
import { pointerKey, slugPurgeUrls } from "../lib/storage/manifest";
import { purgeUrls } from "../lib/storage/purge";
import { r2Store } from "../lib/storage/r2";
import {
  deleteDraft,
  newApiContext,
  pageHtml,
  probeEdge,
  publishViaApi,
  SKIP_LIVE_PUBLISH,
} from "./live-publish";

/**
 * The two §7.3 ordering proofs, END TO END — published through the real
 * `POST /api/publish` and deleted through the real `DELETE /api/anon/:token`,
 * not through the storage helper.
 *
 * `lib/storage/manifest.test.ts` (task 004) and `lib/publish/anon-manage.test.ts`
 * (task 006) run the same two drills one layer down, against `writeManifest` /
 * `removeManifest` and against `deletePage`. This file is the layer above both:
 * it proves the ROUTES an agent actually calls inherit the ordering, which is
 * the only version of the guarantee a caller can rely on.
 *
 * WHY THE FORCED MISS IS THE WHOLE POINT (contract §7.1–7.3). KV is eventually
 * consistent, and the person most likely to open a link inside the propagation
 * window is the person who just published it. The Worker covers that window with
 * ONE R2 `get` of `slugs/{slug}.json`. While KV answers normally the pointer is
 * never read — so "first read after publish 404s" and "deleted page resurrects"
 * are both completely invisible on the happy path, and a suite without a forced
 * miss would stay green on the exact day the ordering was reversed.
 *
 * THE METHOD, stated once: delete the slug's KV key through the Cloudflare REST
 * API, assert it is gone, purge both URL forms so no cached response can answer,
 * and only then probe. Drill 1 is also the POSITIVE CONTROL for drill 2 — it
 * proves this probe returns 200 when a pointer exists, so drill 2's "never a
 * 200" cannot be explained away by a fallback that never fires.
 *
 * SERIAL BY CONSTRUCTION: drill 2 deletes the page drill 1 published, and
 * inherits the forced miss drill 1 established.
 */

/** Contract §6: the documented worst case for a KV read to reflect a write. */
const PROPAGATION_WINDOW_MS = 60_000;
const PROBE_INTERVAL_MS = 3_000;
/** How long a fresh publish gets to answer at the edge before we call it broken. */
const SERVE_TIMEOUT_MS = 25_000;

test.describe("pointer ordering, through the publish and delete APIs", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!!SKIP_LIVE_PUBLISH, String(SKIP_LIVE_PUBLISH));

  const html = pageHtml(`e04-010-drill-${crypto.randomUUID().slice(0, 8)}`);
  let slug = "";
  let liveUrl = "";
  let anonToken = "";

  test.afterAll(async () => {
    if (SKIP_LIVE_PUBLISH || !anonToken) return;
    // Safety net for a mid-drill failure: drill 2 deletes the page itself, and a
    // second delete is idempotent. A draft left behind is a real page on the dev
    // track for seven days.
    const api = await newApiContext();
    try {
      await deleteDraft(api, anonToken);
    } finally {
      await api.dispose();
    }
  });

  test("drill 1 — with the KV key deleted by hand, the pointer keeps the page serving with s-maxage=60", async ({
    request,
  }) => {
    test.setTimeout(180_000);
    test.info().annotations.push({
      type: "forced-kv-miss",
      description:
        "kvStore().delete(slug) over the Cloudflare REST API, confirmed by a follow-up GET returning null, then purge_cache on both URL forms. Probed every 3s for up to 60s (contract §6).",
    });

    const published = await publishViaApi(request, html);
    expect(published.status(), await published.text()).toBe(201);
    const body = (await published.json()) as {
      slug: string;
      live_url: string;
      anonToken: string;
    };
    ({ slug, live_url: liveUrl, anonToken } = body);

    // Normal path first: the page serves at all.
    const serveDeadline = Date.now() + SERVE_TIMEOUT_MS;
    let seen = await probeEdge(liveUrl);
    while (seen.status !== 200 && Date.now() < serveDeadline) {
      await sleep(1_000);
      seen = await probeEdge(liveUrl);
    }
    expect(seen.status, "a freshly published page must serve").toBe(200);
    expect(seen.body).toBe(html);

    // The pointer exists BEFORE we touch KV — the publish wrote it, which is
    // half of "pointer → KV" on its own.
    const pointer = await r2Store().get(pointerKey(slug));
    expect(pointer, "POST /api/publish must write slugs/{slug}.json").not.toBeNull();
    expect(await kvStore().get(slug)).toBe(pointer);

    // FORCE THE MISS.
    await kvStore().delete(slug);
    expect(
      await kvStore().get(slug),
      "the KV key must be gone or this drill tests nothing",
    ).toBeNull();
    // …and purge, or the cached 200 above would answer and prove nothing.
    expect((await purgeUrls(slugPurgeUrls(slug))).ok).toBe(true);

    const deadline = Date.now() + PROPAGATION_WINDOW_MS;
    let last = await probeEdge(liveUrl);
    while (Date.now() < deadline && !last.cacheControl.includes("s-maxage=60")) {
      await sleep(PROBE_INTERVAL_MS);
      last = await probeEdge(liveUrl);
    }

    // 200 alone would prove nothing — it could be a cache hit. `s-maxage=60`
    // instead of the year-long live TTL is the observable signature of a
    // response that came through `slugs/{slug}.json` rather than through KV.
    // A 404 here means the pointer was never written, or was written after KV.
    expect(last.status, "a KV miss must fall through to the pointer").toBe(200);
    expect(last.body).toBe(html);
    expect(last.cacheControl).toMatch(/s-maxage=60\b/);
  });

  test("drill 2 — DELETE removes the pointer first, so the miss never resurrects the page", async ({
    request,
  }) => {
    test.setTimeout(150_000);
    test.info().annotations.push({
      type: "forced-kv-miss",
      description:
        "The KV key deleted by hand in drill 1 is still absent, confirmed by a GET returning null before the first probe. Probed every 3s across the full 60s propagation window; never a 200.",
    });

    expect(anonToken, "drill 1 must have published").not.toBe("");

    const deleted = await request.delete(`/api/anon/${anonToken}`);
    expect(deleted.status(), await deleted.text()).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });

    // The forced miss, established as a FACT rather than hoped for: KV cannot
    // answer for this slug, so every probe below takes the pointer path — the
    // one drill 1 just proved answers 200 when a pointer is there.
    expect(await kvStore().get(slug), "KV must miss, or this drill is theatre").toBeNull();
    expect(
      await r2Store().get(pointerKey(slug)),
      "the pointer must be deleted BEFORE the KV key (contract §7.3)",
    ).toBeNull();

    const deadline = Date.now() + PROPAGATION_WINDOW_MS;
    do {
      const seen = await probeEdge(liveUrl);
      expect(
        seen.status,
        `deleted page served ${seen.status} with "${seen.cacheControl}" — the pointer outlived the KV delete`,
      ).not.toBe(200);
      await sleep(PROBE_INTERVAL_MS);
    } while (Date.now() < deadline);
  });
});
