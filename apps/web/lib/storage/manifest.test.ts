/**
 * `writeManifest` / `removeManifest` — the contract §7.3 drills.
 *
 * NO MOCKS (project rule). Everything below runs against the real dev R2, the
 * real dev KV namespace, the real `purge_cache` endpoint and the deployed dev
 * Worker, exactly as the E03 smoke scripts do. The store clients read their
 * configuration from `apps/web/.env.local`.
 *
 * The live drills therefore SKIP when the dev credentials are absent — CI
 * (`.github/workflows/ci.yml`) runs `pnpm test` with no cloud secrets by design,
 * because it also runs on fork PRs. Run them locally with:
 *
 *   pnpm --filter @kept/web test:unit
 *
 * WHY THE TWO KV-MISS DRILLS ARE THE POINT. The slug pointer is only ever read
 * when KV cannot answer, so every assertion about ordering is invisible on the
 * happy path. The write drill deletes the KV key by hand and expects the page to
 * keep serving with `s-maxage=60` — E03's observable signature of a response
 * that came through `slugs/{slug}.json`. That is also the POSITIVE CONTROL for
 * the delete drill: it proves this probe can see a live pointer, so the delete
 * drill's "never a 200" cannot be explained away by a fallback that never fires.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { config } from "dotenv";

import {
  kvManifestSchema,
  MANIFEST_KV_CACHE_TTL_SECONDS,
  type KvManifest,
} from "@kept/shared";

// The KV client is imported here — and ONLY here outside `manifest.ts` — to
// force the KV miss the two drills are built around. `eslint.config.mjs`
// exempts this file for that reason and no other: nothing below writes a
// manifest through it.
import { kvStore } from "./kv";
import {
  KV_REPURGE_DELAY_MS,
  pointerKey,
  removeManifest,
  repurgeAfterKvPropagation,
  slugPurgeUrls,
  writeManifest,
} from "./manifest";
import { purgeUrls } from "./purge";
import { r2Store } from "./r2";

config({ path: ".env.local", quiet: true });

const LIVE_VARS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_AUTO",
  "KV_NAMESPACE_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "KEPT_BASE_DOMAIN",
] as const;

const missing = LIVE_VARS.filter((name) => !process.env[name]);
const skipLive =
  missing.length > 0
    ? `dev store credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local`
    : false;

/** Contract §6: the documented worst case for a KV read to reflect a write. */
const PROPAGATION_WINDOW_MS = 60_000;
const PROBE_INTERVAL_MS = 3_000;

const SITE_ID = `e04-drill-${crypto.randomUUID().slice(0, 8)}`;
const SLUG = `d${crypto.randomUUID().replace(/-/g, "").slice(0, 7)}`;

/** `sites/{siteId}/{versionId}/index.html` — the locked R2 layout. The publish
 *  route (task 005) grows the real builder; this is a fixture path. */
const objectKey = (versionId: string) => `sites/${SITE_ID}/${versionId}/index.html`;
const pageHtml = (marker: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marker}</title></head><body><h1>${marker}</h1></body></html>\n`;

const manifestFor = (versionId: string): KvManifest =>
  kvManifestSchema.parse({
    siteId: SITE_ID,
    versionId,
    status: "live",
    region: "auto",
    ownerId: null,
    updatedAt: Date.now(),
  });

const edgeUrl = () => `https://${SLUG}.${process.env.KEPT_BASE_DOMAIN}/`;

/** No query string, ever: it would change the cache key and quietly defeat the
 *  purge this is meant to observe. */
async function probe(): Promise<{ status: number; cacheControl: string; body: string }> {
  const res = await fetch(edgeUrl(), { redirect: "manual" });
  return {
    status: res.status,
    cacheControl: res.headers.get("cache-control") ?? "",
    body: await res.text(),
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

after(async () => {
  if (skipLive) return;
  // Best effort: leave neither a pointer, a KV key nor an object behind.
  await removeManifest(SLUG).catch(() => undefined);
  const r2 = r2Store();
  await Promise.all([
    r2.delete(objectKey("v1")).catch(() => undefined),
    r2.delete(objectKey("v2")).catch(() => undefined),
  ]);
});

test("pointer key and purge URLs match the contract", () => {
  assert.equal(pointerKey("abc12345"), "slugs/abc12345.json");

  const prior = process.env.KEPT_BASE_DOMAIN;
  process.env.KEPT_BASE_DOMAIN = "kept-test.example";
  try {
    // §4: `purge_cache` matches the URL string exactly, so both forms or the
    // edge keeps serving one of them for a year.
    assert.deepEqual(slugPurgeUrls("abc12345"), [
      "https://abc12345.kept-test.example/",
      "https://abc12345.kept-test.example/index.html",
    ]);
  } finally {
    restoreEnv("KEPT_BASE_DOMAIN", prior);
  }
});

test("the re-purge delay clears the edge's KV read cache twice over", () => {
  // The bound the second purge rests on, asserted against the number the Worker
  // actually passes to `KEPT_KV.get`. At the moment a manifest changes the
  // colo's KV entry has at most one `cacheTtl` of life left, and the single
  // stale read it permits refreshes it by at most one more — so anything below
  // 2× is a re-purge that can fire while the edge is still able to answer with
  // the pre-change manifest, which is the bug it exists to close.
  assert.ok(
    KV_REPURGE_DELAY_MS > 2 * MANIFEST_KV_CACHE_TTL_SECONDS * 1000,
    `KV_REPURGE_DELAY_MS (${KV_REPURGE_DELAY_MS}ms) must exceed twice the edge's KV cacheTtl (${MANIFEST_KV_CACHE_TTL_SECONDS}s)`,
  );
});

test(
  "the re-purge is a real purge, not a scheduled no-op",
  { skip: skipLive },
  async () => {
    // Same endpoint, same credentials, same URL forms as the first purge — run
    // with a zero delay so the assertion is about the call, not the clock.
    const result = await repurgeAfterKvPropagation(SLUG, slugPurgeUrls(SLUG), 0);
    assert.equal(result.ok, true, result.ok ? "" : result.error);
  },
);

test("an invalid manifest fails at the validate step, before either store", async () => {
  const result = await writeManifest("abc12345", {
    siteId: "s",
    versionId: "v",
    // The Worker's total switch has no branch for this, and an unparseable
    // pointer is a branded 404 — so it must never reach a store.
    status: "resting",
    region: "auto",
    ownerId: null,
    updatedAt: Date.now(),
  } as unknown as KvManifest);

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.step, "validate");
});

test(
  "write drill: pointer is byte-identical to KV, and a replace purges the edge",
  { skip: skipLive },
  async () => {
    const r2 = r2Store();
    const kv = kvStore();

    await r2.put(objectKey("v1"), pageHtml("drill-v1"), "text/html; charset=utf-8");
    const first = await writeManifest(SLUG, manifestFor("v1"));
    assert.equal(first.ok, true, first.ok ? "" : `${first.step}: ${first.error}`);
    assert.ok(first.ok && first.purge.ok, "purge should succeed against the dev zone");

    // §7.2 byte-identity, asserted against what is actually in the two stores.
    const pointerBody = await r2.get(pointerKey(SLUG));
    const kvValue = await kv.get(SLUG);
    assert.equal(pointerBody, first.ok ? first.value : null);
    assert.equal(kvValue, pointerBody);

    const live = await probe();
    assert.equal(live.status, 200);
    assert.match(live.body, /drill-v1/);

    // THE PURGE PROOF. The response above is now in the Cache API with
    // `s-maxage=31536000`. Nothing expires on its own (§1): if the new bytes
    // show up here, the purge inside `writeManifest` is what did it.
    await r2.put(objectKey("v2"), pageHtml("drill-v2"), "text/html; charset=utf-8");
    const replaced = await writeManifest(SLUG, manifestFor("v2"));
    assert.equal(replaced.ok, true, replaced.ok ? "" : `${replaced.step}: ${replaced.error}`);

    const afterReplace = await probe();
    assert.equal(afterReplace.status, 200);
    assert.match(afterReplace.body, /drill-v2/);
  },
);

test(
  "write drill under a FORCED KV miss: the pointer keeps the page serving with s-maxage=60",
  { skip: skipLive },
  async () => {
    const kv = kvStore();

    // Force the miss the same way E03 task 009 did: delete the KV key by hand,
    // leaving the pointer in place. Then purge, or the cached 200 from the
    // previous test would answer and prove nothing.
    await kv.delete(SLUG);
    assert.equal(await kv.get(SLUG), null, "KV key must be gone for this to test anything");
    assert.ok((await purgeUrls(slugPurgeUrls(SLUG))).ok);

    const deadline = Date.now() + PROPAGATION_WINDOW_MS;
    let last = await probe();
    while (Date.now() < deadline && !last.cacheControl.includes("s-maxage=60")) {
      await sleep(PROBE_INTERVAL_MS);
      last = await probe();
    }

    // 200 + the short TTL is the signature of a response served through
    // `slugs/{slug}.json` rather than KV. A 404 means the pointer was never
    // written, or was written after KV.
    assert.equal(last.status, 200, "a KV miss must fall through to the pointer");
    assert.match(last.body, /drill-v2/);
    assert.match(last.cacheControl, /s-maxage=60\b/);
  },
);

test(
  "delete drill under a FORCED KV miss: a removed page is never resurrected",
  { skip: skipLive },
  async () => {
    const r2 = r2Store();
    const kv = kvStore();

    const removed = await removeManifest(SLUG);
    assert.equal(removed.ok, true, removed.ok ? "" : `${removed.step}: ${removed.error}`);
    assert.ok(removed.ok && removed.purge.ok);

    // THE FORCED MISS, established as a fact rather than hoped for: KV cannot
    // answer for this slug, so every request below takes the pointer path —
    // the one the previous test just proved returns 200 when a pointer exists.
    assert.equal(await kv.get(SLUG), null, "KV must miss, or this drill is theatre");
    assert.equal(await r2.get(pointerKey(SLUG)), null, "the pointer must be gone first");

    // The page object is deliberately still in R2: the only thing standing
    // between a visitor and the deleted page is the pointer's absence.
    assert.notEqual(await r2.get(objectKey("v2")), null);

    const deadline = Date.now() + PROPAGATION_WINDOW_MS;
    do {
      const seen = await probe();
      assert.notEqual(
        seen.status,
        200,
        `deleted page served ${seen.status} with ${seen.cacheControl} — the pointer outlived the KV delete`,
      );
      await sleep(PROBE_INTERVAL_MS);
    } while (Date.now() < deadline);
  },
);

test(
  "purge failure is logged and non-fatal — the write still succeeds",
  { skip: skipLive },
  async () => {
    const r2 = r2Store();
    await r2.put(objectKey("v1"), pageHtml("drill-v1"), "text/html; charset=utf-8");

    // A real configuration failure, not a stub: `purgeConfig()` re-reads the
    // environment on every call, so unsetting the zone id makes the purge fail
    // exactly as it would on a misconfigured deploy.
    const prior = process.env.CLOUDFLARE_ZONE_ID;
    const errors: string[] = [];
    const realError = console.error;

    const result = await (async () => {
      console.error = (...args: unknown[]) => void errors.push(args.join(" "));
      delete process.env.CLOUDFLARE_ZONE_ID;
      try {
        return await writeManifest(SLUG, manifestFor("v1"));
      } finally {
        console.error = realError;
        restoreEnv("CLOUDFLARE_ZONE_ID", prior);
      }
    })();

    assert.equal(result.ok, true, "a failed purge must never fail the write");
    assert.equal(result.ok && result.purge.ok, false);
    assert.equal(errors.length, 1);
    const [logged = ""] = errors;
    assert.match(logged, new RegExp(SLUG));
    for (const url of slugPurgeUrls(SLUG)) assert.ok(logged.includes(url));

    // The stores are correct even though the edge is stale — that is the whole
    // justification for not rolling back.
    assert.equal(await kvStore().get(SLUG), result.ok ? result.value : null);
  },
);

test(
  "delete drill with NO forced miss: a live KV entry must not let the edge re-cache the deleted page",
  { skip: skipLive },
  async () => {
    // ⚠️ THE DRILL EVERY OTHER DELETE TEST IN THIS REPO SKIPS PAST. All of them
    // — here, in `lib/publish/anon-manage.test.ts` and in
    // `e2e/pointer-ordering.spec.ts` — delete the KV key BY HAND first, to force
    // the pointer path. That is the right way to prove the §7.3 ordering, and it
    // is also why none of them could see this bug: by the time the delete runs,
    // KV is already empty, so the edge cannot answer with a stale manifest and
    // the Cache API has nothing to re-cache.
    //
    // The production failure needs the opposite setup: a live KV entry, a
    // POPULATED Cache API entry, and a delete through the ordinary path.
    // `purge_cache` empties the Cache API but not the Worker's KV read cache, so
    // the next request re-reads the pre-delete manifest and re-stores the
    // deleted page under `s-maxage=31536000`. With one purge that is permanent;
    // the assertion below is simply that it ends.
    //
    // ⚠️ WHAT THIS DRILL CANNOT PROVE, stated so nobody trusts it further than
    // it goes. Run from a laptop, the KV delete and the probes usually leave from
    // the SAME colo, and the delete's invalidation reaches the read cache
    // sub-second — so the loop below normally exits on the first probe and would
    // stay green with the re-purge removed. The window opens reliably only when
    // the deleting control plane is in a different region from the reader, which
    // is the deployed shape and not this one. The gate that actually fails on a
    // regression is the takedown poll in `scripts/smoke-release.ts`, which runs
    // against the deployed control plane after every release. This drill's job
    // is the coverage no other test here has — a delete with KV LIVE — plus a
    // ceiling on how long a deleted page may serve.
    const r2 = r2Store();
    const siteId = `e04-repurge-${crypto.randomUUID().slice(0, 8)}`;
    const slug = `d${crypto.randomUUID().replace(/-/g, "").slice(0, 7)}`;
    const key = `sites/${siteId}/v1/index.html`;
    const url = `https://${slug}.${process.env.KEPT_BASE_DOMAIN}/`;
    const marker = "repurge-drill";

    const probeOnce = async () => {
      const res = await fetch(url, { redirect: "manual" });
      return {
        status: res.status,
        cacheControl: res.headers.get("cache-control") ?? "",
        body: await res.text(),
      };
    };

    try {
      await r2.put(key, pageHtml(marker), "text/html; charset=utf-8");
      const written = await writeManifest(
        slug,
        kvManifestSchema.parse({
          siteId,
          versionId: "v1",
          status: "live",
          region: "auto",
          ownerId: null,
          updatedAt: Date.now(),
        }),
      );
      assert.equal(written.ok, true, written.ok ? "" : `${written.step}: ${written.error}`);

      // Serve it FROM KV before deleting, and insist on it: `s-maxage=31536000`
      // is the signature of the KV path, `s-maxage=60` of the pointer fallback.
      // The distinction is the whole drill. A 200 served through the pointer
      // leaves the colo's KV read cache holding a MISS, so the delete looks
      // instantaneous and the test passes without touching the bug — which is
      // precisely how this failure hid behind a green suite.
      const serveDeadline = Date.now() + PROPAGATION_WINDOW_MS;
      let live = await probeOnce();
      while (
        !(live.status === 200 && live.cacheControl.includes("s-maxage=31536000")) &&
        Date.now() < serveDeadline
      ) {
        await sleep(PROBE_INTERVAL_MS);
        live = await probeOnce();
      }
      assert.equal(live.status, 200, "the page must be serving before it is deleted");
      assert.match(live.body, new RegExp(marker));
      assert.match(
        live.cacheControl,
        /s-maxage=31536000\b/,
        "the page must be served from KV — a pointer-served 200 does not arm this drill",
      );

      const removed = await removeManifest(slug);
      assert.equal(removed.ok, true, removed.ok ? "" : `${removed.step}: ${removed.error}`);
      assert.ok(removed.ok && removed.purge.ok);
      assert.equal(await kvStore().get(slug), null);
      assert.equal(await r2.get(pointerKey(slug)), null);

      // Poll continuously — the probes ARE the traffic that re-poisons the cache
      // after the first purge, which is exactly what a real visitor does. Under
      // a single purge this loop never exits: the page serves 200 forever.
      const deadline = Date.now() + KV_REPURGE_DELAY_MS + 30_000;
      let seen = await probeOnce();
      while (seen.status === 200 && Date.now() < deadline) {
        await sleep(PROBE_INTERVAL_MS);
        seen = await probeOnce();
      }
      assert.notEqual(
        seen.status,
        200,
        `a deleted page was still serving ${Math.round((Date.now() - deadline + KV_REPURGE_DELAY_MS + 30_000) / 1000)}s after the delete — the re-purge never corrected the entry the edge re-cached from a stale KV read`,
      );
    } finally {
      await removeManifest(slug).catch(() => undefined);
      await r2.delete(key).catch(() => undefined);
    }
  },
);
