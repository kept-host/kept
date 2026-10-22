// Multi-file sites at the edge (E08 D8, D12, D13, Q-new-1, Q-new-6).
//
// The cost model is the claim under test, so every read count below is COUNTED
// with `countingEnv` against the real local R2 — never inferred from a status
// code. The budget: one KV + one R2 read per cold request, including an SPA's
// deep route (rewritten BEFORE the read). The only second reads are misses: an
// extensionless miss on a non-SPA site probes `{path}/index.html` (Q-new-6), and
// a miss on a `has404` site reads its `404.html` (D13). A store error takes
// neither.

import { beforeAll, describe, expect, it } from "vitest";

import { SITE_FILE_TYPES, type KvManifest } from "@kept/shared";

import { LIVE_CACHE_CONTROL, SHORT_EDGE_CACHE_CONTROL } from "../src/cache";
import { CONTENT_TYPES } from "../src/r2";
import {
  countingEnv,
  describeCounts,
  describeResponse,
  dispatch,
  dispatchText,
  evictFromCache,
  manifest,
  objectKey,
  pageHtml,
  requestFor,
  seedManifest,
  seedObject,
  SYSTEM_PAGE_TITLES,
  type StoreCounts,
} from "./fixtures";

const ROOT_HTML = "<!doctype html><title>shell</title><div id=app></div>";
const ABOUT_HTML = "<!doctype html><title>about</title><h1>about us</h1>";
const CUSTOM_404_HTML = "<!doctype html><title>lost</title><h1>our own 404</h1>";

/** Seed a multi-file site: the root page, an asset, optional extra files. */
async function seedMultiFile(
  slug: string,
  flags: Pick<KvManifest, "spa" | "has404">,
  extra: Record<string, string> = {},
): Promise<KvManifest> {
  const m = manifest({ siteId: `site-${slug}`, ...flags });
  await seedObject(m, ROOT_HTML);
  await seedObject(m, "console.log('app')", "assets/app.js");
  for (const [path, body] of Object.entries(extra)) await seedObject(m, body, path);
  await seedManifest(slug, m);
  return m;
}

/** One cold, counted request: the cache entry is evicted first. */
async function coldCounted(
  slug: string,
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; text: string; counts: StoreCounts }> {
  const request = requestFor(slug, path, init);
  await evictFromCache(request);
  const { env: counted, counts } = countingEnv();
  const { response, text } = await dispatchText(request, counted);
  return { response, text, counts };
}

function expectReads(counts: StoreCounts, keys: string[], why: string): void {
  expect(counts.kvGet, `${why}: one KV read — ${describeCounts(counts)}`).toBe(1);
  expect(counts.r2Keys, `${why} — ${describeCounts(counts)}`).toEqual(keys);
  expect(counts.otherCalls, `${why}: no head/list — ${describeCounts(counts)}`).toEqual([]);
}

describe("Content-Type is the shared SITE_FILE_TYPES table (AC19)", () => {
  it("is the shared object itself, not a copy", () => {
    expect(CONTENT_TYPES, "the edge must read @kept/shared's table so publish and serve cannot drift").toBe(
      SITE_FILE_TYPES,
    );
  });

  const typed: { path: string; contentType: string }[] = [
    { path: "assets/app.js", contentType: "text/javascript; charset=utf-8" },
    { path: "models/scene.glb", contentType: SITE_FILE_TYPES.glb.contentType },
    { path: "pkg/engine.wasm", contentType: SITE_FILE_TYPES.wasm.contentType },
    { path: "modules/main.mjs", contentType: SITE_FILE_TYPES.mjs.contentType },
    { path: "img/hero.avif", contentType: SITE_FILE_TYPES.avif.contentType },
    { path: "audio/theme.mp3", contentType: SITE_FILE_TYPES.mp3.contentType },
    // Unknown extension and prototype keys: opaque bytes, never a guess.
    { path: "data/blob.xyz", contentType: "application/octet-stream" },
    { path: "weird/file.constructor", contentType: "application/octet-stream" },
    { path: "weird/file.__proto__", contentType: "application/octet-stream" },
  ];

  for (const { path, contentType } of typed) {
    it(`serves /${path} as ${contentType}`, async () => {
      const slug = `mf-type-${path.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`.replace(/-+$/, "");
      await seedMultiFile(slug, {}, { [path]: "payload" });

      const response = await dispatch(requestFor(slug, `/${path}`));

      expect(response.status, `expected 200 for /${path}, got ${describeResponse(response)}`).toBe(200);
      expect(response.headers.get("content-type"), `/${path} must be typed from SITE_FILE_TYPES`).toBe(contentType);
    });
  }
});

describe("SPA rewrite (AC20, Q-new-1)", () => {
  const SLUG = "mf-spa";
  let m: KvManifest;

  beforeAll(async () => {
    m = await seedMultiFile(SLUG, { spa: true }, { "about/index.html": ABOUT_HTML });
  });

  it("serves the root index.html for a deep route, in exactly one R2 read, short-cached", async () => {
    const { response, text, counts } = await coldCounted(SLUG, "/dashboard/settings");

    expect(response.status, describeResponse(response, text)).toBe(200);
    expect(text, "a deep SPA route must serve the root shell").toBe(ROOT_HTML);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(
      response.headers.get("cache-control"),
      "a rewritten route is not a URL the write side purges, so it is edge-cached for a minute (Q-new-1)",
    ).toBe(SHORT_EDGE_CACHE_CONTROL);
    expectReads(counts, [objectKey(m)], "the rewrite happens before the read");
  });

  it("answers a conditional deep route with a short-cached 304, still one read", async () => {
    const first = await coldCounted(SLUG, "/dashboard");
    const etag = first.response.headers.get("etag") ?? "";
    expect(etag, "fixture sanity: the shell carries an ETag").not.toBe("");

    const { response, counts } = await coldCounted(SLUG, "/dashboard", { headers: { "If-None-Match": etag } });

    expect(response.status, describeResponse(response)).toBe(304);
    expect(response.headers.get("cache-control")).toBe(SHORT_EDGE_CACHE_CONTROL);
    expectReads(counts, [objectKey(m)], "a matching conditional is still one read");
  });

  for (const path of ["/", "/index.html"]) {
    it(`keeps LIVE_CACHE_CONTROL for ${path} — no rewrite happened`, async () => {
      const { response, text, counts } = await coldCounted(SLUG, path);

      expect(response.status, describeResponse(response, text)).toBe(200);
      expect(response.headers.get("cache-control")).toBe(LIVE_CACHE_CONTROL);
      expectReads(counts, [objectKey(m)], `${path} reads index.html once`);
    });
  }

  it("serves a real asset as itself, long-cached", async () => {
    const { response, counts } = await coldCounted(SLUG, "/assets/app.js");

    expect(response.status, describeResponse(response)).toBe(200);
    expect(response.headers.get("cache-control")).toBe(LIVE_CACHE_CONTROL);
    expectReads(counts, [objectKey(m, "assets/app.js")], "an asset is one read");
  });

  it("answers a missing file (with an extension) with the branded 404, in exactly one R2 read", async () => {
    const { response, text, counts } = await coldCounted(SLUG, "/missing.png");

    expect(response.status, describeResponse(response, text)).toBe(404);
    expect(text).toContain(SYSTEM_PAGE_TITLES.notFound);
    expectReads(counts, [objectKey(m, "missing.png")], "a file miss on an SPA without 404.html is one read");
  });

  it("never takes the directory branch: /about serves the shell, not a 301 (Q-new-6)", async () => {
    const { response, text, counts } = await coldCounted(SLUG, "/about");

    expect(response.status, describeResponse(response, text)).toBe(200);
    expect(text, "an SPA owns every route; the folder is not probed").toBe(ROOT_HTML);
    expectReads(counts, [objectKey(m)], "an SPA route is one read, no directory probe");
  });
});

describe("without spa (AC21)", () => {
  const SLUG = "mf-plain";
  let m: KvManifest;

  beforeAll(async () => {
    m = await seedMultiFile(SLUG, {});
  });

  it("answers /dashboard/settings with the branded 404, as before", async () => {
    const { response, text, counts } = await coldCounted(SLUG, "/dashboard/settings");

    expect(response.status, describeResponse(response, text)).toBe(404);
    expect(text).toContain(SYSTEM_PAGE_TITLES.notFound);
    expectReads(
      counts,
      [objectKey(m, "dashboard/settings"), objectKey(m, "dashboard/settings/index.html")],
      "an extensionless miss probes the folder once (Q-new-6), then 404s",
    );
  });
});

describe("directory → trailing slash (Q-new-6)", () => {
  const SLUG = "mf-dirs";
  let m: KvManifest;

  beforeAll(async () => {
    m = await seedMultiFile(SLUG, {}, { "about/index.html": ABOUT_HTML });
  });

  it("301s /about to /about/ after exactly two R2 reads, short-cached", async () => {
    const { response, counts } = await coldCounted(SLUG, "/about");

    expect(response.status, describeResponse(response)).toBe(301);
    expect(response.headers.get("location")).toBe("/about/");
    expect(
      response.headers.get("cache-control"),
      "a replace can remove the folder and /about is not a purged URL",
    ).toBe(SHORT_EDGE_CACHE_CONTROL);
    expectReads(counts, [objectKey(m, "about"), objectKey(m, "about/index.html")], "a miss, then the folder probe");
  });

  it("preserves the query string", async () => {
    const { response } = await coldCounted(SLUG, "/about?ref=home&x=1");

    expect(response.status, describeResponse(response)).toBe(301);
    expect(response.headers.get("location")).toBe("/about/?ref=home&x=1");
  });

  it("never emits a protocol-relative Location for a doubled leading slash", async () => {
    const { response } = await coldCounted(SLUG, "//about");

    expect(response.status, describeResponse(response)).toBe(301);
    expect(response.headers.get("location"), "`//about/` would send the visitor to the host `about`").toBe("/about/");
  });

  it("serves /about/ itself in one read", async () => {
    const { response, text, counts } = await coldCounted(SLUG, "/about/");

    expect(response.status, describeResponse(response, text)).toBe(200);
    expect(text).toBe(ABOUT_HTML);
    expectReads(counts, [objectKey(m, "about/index.html")], "the trailing-slash form is one read");
  });

  it("answers /missing with the branded 404 after the folder probe", async () => {
    const { response, text, counts } = await coldCounted(SLUG, "/missing");

    expect(response.status, describeResponse(response, text)).toBe(404);
    expect(text).toContain(SYSTEM_PAGE_TITLES.notFound);
    expectReads(counts, [objectKey(m, "missing"), objectKey(m, "missing/index.html")], "a miss and one probe");
  });

  it("never probes for a file with an extension: /x.png misses in one read", async () => {
    const { response, counts } = await coldCounted(SLUG, "/x.png");

    expect(response.status, describeResponse(response)).toBe(404);
    expectReads(counts, [objectKey(m, "x.png")], "a file miss takes no extra read");
  });

  it("serves the site's own 404.html after the probe when has404 is set", async () => {
    const slug = "mf-dirs-404";
    const m404 = await seedMultiFile(slug, { has404: true }, { "404.html": CUSTOM_404_HTML });

    const { response, text, counts } = await coldCounted(slug, "/missing");

    expect(response.status, describeResponse(response, text)).toBe(404);
    expect(text).toBe(CUSTOM_404_HTML);
    expectReads(
      counts,
      [objectKey(m404, "missing"), objectKey(m404, "missing/index.html"), objectKey(m404, "404.html")],
      "the miss, the folder probe, then the custom 404",
    );
  });
});

describe("custom 404.html (AC22)", () => {
  const SLUG = "mf-has404";
  let m: KvManifest;
  let userPageCsp: string | null;

  beforeAll(async () => {
    m = await seedMultiFile(SLUG, { has404: true }, { "404.html": CUSTOM_404_HTML });
    userPageCsp = (await dispatch(requestFor(SLUG, "/assets/app.js"))).headers.get("content-security-policy");
  });

  it("reads 404.html once on a miss and serves it as a short-cached user-page 404", async () => {
    const { response, text, counts } = await coldCounted(SLUG, "/nope.html");

    expect(response.status, describeResponse(response, text)).toBe(404);
    expect(text, "the site's own 404.html, not the branded page").toBe(CUSTOM_404_HTML);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe(SHORT_EDGE_CACHE_CONTROL);
    expect(
      response.headers.get("content-security-policy"),
      "a stranger's bytes carry the user-page header set, never kept's strict CSP",
    ).toBe(userPageCsp);
    expect(response.headers.get("etag"), "the 404 must not be revalidated as if it were the URL asked for").toBeNull();
    expectReads(counts, [objectKey(m, "nope.html"), objectKey(m, "404.html")], "two reads: the miss and 404.html");
  });

  it("falls back to the branded 404 when 404.html is missing too, after two reads", async () => {
    const slug = "mf-has404-gone";
    const gone = await seedMultiFile(slug, { has404: true });

    const { response, text, counts } = await coldCounted(slug, "/nope.html");

    expect(response.status, describeResponse(response, text)).toBe(404);
    expect(text).toContain(SYSTEM_PAGE_TITLES.notFound);
    expectReads(counts, [objectKey(gone, "nope.html"), objectKey(gone, "404.html")], "two reads, then branded");
  });

  it("without has404, the branded 404 after one read", async () => {
    const slug = "mf-no404";
    const plain = await seedMultiFile(slug, {}, { "404.html": CUSTOM_404_HTML });

    const { response, text, counts } = await coldCounted(slug, "/nope.html");

    expect(response.status, describeResponse(response, text)).toBe(404);
    expect(text).toContain(SYSTEM_PAGE_TITLES.notFound);
    expectReads(counts, [objectKey(plain, "nope.html")], "an un-flagged site never reads 404.html");
  });

  it("with spa and has404, /missing.png costs two reads and serves 404.html", async () => {
    const slug = "mf-spa-404";
    const both = await seedMultiFile(slug, { spa: true, has404: true }, { "404.html": CUSTOM_404_HTML });

    const { response, text, counts } = await coldCounted(slug, "/missing.png");

    expect(response.status, describeResponse(response, text)).toBe(404);
    expect(text).toBe(CUSTOM_404_HTML);
    expectReads(counts, [objectKey(both, "missing.png"), objectKey(both, "404.html")], "the miss and 404.html");
  });

  it("does not read 404.html after a store error", async () => {
    // R2 genuinely throws on an object name over 1024 bytes (see
    // `store-errors.test.ts`): an outage, not a miss, so no second read.
    const overLong = `/${"p".repeat(1020)}`;
    const { response, text, counts } = await coldCounted(SLUG, overLong);

    expect(response.status, describeResponse(response, text)).toBe(404);
    expect(text).toContain(SYSTEM_PAGE_TITLES.notFound);
    expectReads(counts, [objectKey(m, overLong.slice(1))], "a store error is never followed by another read");
  });
});

describe("the traversal guard still runs first on an SPA (AC24)", () => {
  const SLUG = "mf-spa-guard";
  const VICTIM = "mf-victim";

  beforeAll(async () => {
    await seedMultiFile(SLUG, { spa: true, has404: true }, { "404.html": CUSTOM_404_HTML });
    const victim = manifest({ siteId: `site-${VICTIM}` });
    await seedObject(victim, pageHtml(VICTIM));
    await seedManifest(VICTIM, victim);
  });

  // Each survives the URL parser and is rejected by `resolvePath` — so it must
  // cost ZERO R2 reads. A rewrite that ran first would read index.html and 200.
  const rejected: { name: string; path: string }[] = [
    { name: "an encoded-slash ../ traversal", path: `/..%2F..%2Fsites%2Fsite-${VICTIM}%2Fv1%2Findex` },
    { name: "a %2e%2e with an encoded slash", path: `/%2e%2e%2F%2e%2e%2Fsites%2Fsite-${VICTIM}` },
    { name: "an encoded backslash", path: "/dashboard%5Csettings" },
    { name: "an encoded NUL", path: "/dashboard%00settings" },
    { name: "an encoded control character", path: "/dashboard%1Fsettings" },
  ];

  for (const { name, path } of rejected) {
    it(`rejects ${name} before any R2 read`, async () => {
      const { response, text, counts } = await coldCounted(SLUG, path);

      expect(response.status, describeResponse(response, text)).toBe(404);
      expect(text).toContain(SYSTEM_PAGE_TITLES.notFound);
      expect(counts.r2Get, `a rejected path must never reach R2 — ${describeCounts(counts)}`).toBe(0);
    });
  }

  // These are normalized away or decoded only once, so they reach R2 — but only
  // inside this site's own prefix, and never as `..`.
  const contained = [
    "/../../sites/site-mf-victim/v1/index",
    "/%2e%2e/%2e%2e/sites/site-mf-victim/v1/index",
    "/%252e%252e/%252e%252e/sites/site-mf-victim/v1/index.html",
  ];

  for (const path of contained) {
    it(`keeps ${path} inside the site's own prefix`, async () => {
      const { text, counts } = await coldCounted(SLUG, path);

      expect(text, "another tenant's bytes must never come back").not.toContain(pageHtml(VICTIM));
      for (const key of counts.r2Keys) {
        expect(key, describeCounts(counts)).toMatch(new RegExp(`^sites/site-${SLUG}/v1/`));
        expect(key.split("/"), describeCounts(counts)).not.toContain("..");
      }
    });
  }
});
