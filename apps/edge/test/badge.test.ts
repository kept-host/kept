// E10 D1–D2 — the badge, streamed into HTML responses by `HTMLRewriter`.
//
// Real KV, real R2, real `HTMLRewriter` on workerd. The expected markup always
// comes from `renderBadge` itself, so these tests pin WHERE the badge lands and
// WHEN — the markup's own bytes are pinned by `apps/web/lib/badge/contract.test.ts`.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { renderBadge, type BadgeData, type KvManifest } from "@kept/shared";

import {
  APEX_ORIGIN,
  BASE_DOMAIN,
  countingEnv,
  describeCounts,
  describeResponse,
  dispatch,
  dispatchText,
  evictFromCache,
  manifest,
  requestFor,
  seedManifest,
  seedObject,
} from "./fixtures";

const KEPT: BadgeData = { variant: "kept", style: "standard", refCode: "maker", handle: "maker" };
const DRAFT: BadgeData = { variant: "draft", style: "standard" };

function badgeFor(slug: string, data: BadgeData) {
  return renderBadge(data, {
    apexOrigin: APEX_ORIGIN,
    pageOrigin: `https://${slug}.${BASE_DOMAIN}`,
    slug,
  });
}

/** Seed a badged site with `files` (path → body) and return its manifest. */
async function seedBadged(
  slug: string,
  files: Record<string, string>,
  overrides: Partial<KvManifest> = {},
): Promise<KvManifest> {
  const m = manifest({ siteId: `site-${slug}`, badge: KEPT, ...overrides });
  for (const [path, body] of Object.entries(files)) await seedObject(m, body, path);
  await seedManifest(slug, m);
  return m;
}

async function cold(slug: string, path = "/", init?: RequestInit) {
  const request = requestFor(slug, path, init);
  await evictFromCache(request);
  return dispatchText(request);
}

describe("injection point", () => {
  it("appends the badge right before </body>", async () => {
    const slug = "badge-body";
    await seedBadged(slug, { "index.html": "<html><body><h1>hi</h1></body></html>" });
    const { response, text } = await cold(slug);
    expect(response.status, describeResponse(response, text)).toBe(200);
    expect(text).toBe(`<html><body><h1>hi</h1>${badgeFor(slug, KEPT).html}</body></html>`);
    expect(response.headers.get("content-length"), "a rewritten response has no Content-Length").toBeNull();
  });

  it("appends at the document end when there is no <body> (edge case 1)", async () => {
    const slug = "badge-nobody";
    await seedBadged(slug, { "index.html": "<h1>bare</h1>" });
    const { text } = await cold(slug);
    expect(text).toBe(`<h1>bare</h1>${badgeFor(slug, KEPT).html}`);
  });

  it("appends at the document end when <body> is never closed (edge case 2)", async () => {
    const slug = "badge-unclosed";
    await seedBadged(slug, { "index.html": "<html><body><p>open" });
    const { text } = await cold(slug);
    expect(text).toBe(`<html><body><p>open${badgeFor(slug, KEPT).html}`);
  });

  it("ignores a </body> inside a script string and injects exactly once", async () => {
    const slug = "badge-script";
    const page = `<html><body><script>var s = "</body>";</script><p>x</p></body></html>`;
    await seedBadged(slug, { "index.html": page });
    const { text } = await cold(slug);
    const html = badgeFor(slug, KEPT).html;
    expect(text).toBe(page.replace("</body></html>", `${html}</body></html>`));
    expect(text.split("<kept-badge>").length - 1, "exactly one badge").toBe(1);
  });

  it("injects once into a document with two </body> tags", async () => {
    const slug = "badge-twice";
    await seedBadged(slug, { "index.html": "<body>a</body><body>b</body>" });
    const { text } = await cold(slug);
    expect(text.split("<kept-badge>").length - 1).toBe(1);
  });
});

describe("variants and escaping", () => {
  it("escapes <, \" and & in the model and the handle (they are escaped by renderBadge, never concatenated here)", async () => {
    const slug = "badge-escape";
    const data: BadgeData = { variant: "kept", style: "standard", model: `<x" & y>`, handle: "a&b" };
    await seedBadged(slug, { "index.html": "<body></body>" }, { badge: data });
    const { text } = await cold(slug);
    expect(text).toContain("Made with &lt;x&quot; &amp; y&gt;");
    expect(text).toContain("by @a&amp;b");
    expect(text).not.toContain(`<x" & y>`);
  });

  it("the draft variant carries no claim link, token or keep URL (D4)", async () => {
    const slug = "badge-draft";
    await seedBadged(slug, { "index.html": "<body></body>" }, { badge: DRAFT });
    const { text } = await cold(slug);
    expect(text).toContain(badgeFor(slug, DRAFT).html);
    expect(text).toContain(`${APEX_ORIGIN}/drafts`);
    for (const forbidden of ["claim", "token", "/keep", "?ref="]) {
      expect(text, `draft badge must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("the minimal style injects its own markup", async () => {
    const slug = "badge-minimal";
    const data: BadgeData = { ...KEPT, style: "minimal" };
    await seedBadged(slug, { "index.html": "<body></body>" }, { badge: data });
    const { text } = await cold(slug);
    expect(text).toBe(`<body>${badgeFor(slug, data).html}</body>`);
  });
});

describe("where the badge never goes", () => {
  const ASSETS: Record<string, string> = {
    "app.js": `document.write("</body>");`,
    "style.css": "body{color:red}",
    "data.json": `{"html":"</body>"}`,
    "pic.svg": `<svg xmlns="http://www.w3.org/2000/svg"><body></body></svg>`,
  };

  for (const [path, body] of Object.entries(ASSETS)) {
    it(`serves /${path} byte-identically with R2's own ETag`, async () => {
      const slug = `badge-asset-${path.replace(".", "-")}`;
      const m = await seedBadged(slug, { "index.html": "<body></body>", [path]: body });
      const { response, text } = await cold(slug, `/${path}`);
      expect(response.status).toBe(200);
      expect(text).toBe(body);
      const object = await env.KEPT_R2.head(
        `sites/${m.siteId}/${m.versionId}/${path}`,
      );
      expect(response.headers.get("etag")).toBe(object?.httpEtag);
    });
  }

  it("serves a manifest without `badge` unchanged", async () => {
    const slug = "badge-none";
    const page = "<html><body>plain</body></html>";
    await seedBadged(slug, { "index.html": page }, { badge: undefined });
    const { text } = await cold(slug);
    expect(text).toBe(page);
  });

  it("does not badge the branded system pages", async () => {
    const slug = "badge-system";
    await seedBadged(slug, { "index.html": "<body></body>" }, { status: "expired" });
    const { text } = await cold(slug);
    expect(text).not.toContain("<kept-badge>");
  });

  it("does not badge a HEAD response (it has no body)", async () => {
    const slug = "badge-head";
    await seedBadged(slug, { "index.html": "<body></body>" });
    const response = await dispatch(requestFor(slug, "/", { method: "HEAD" }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("does not badge a 301", async () => {
    const slug = "badge-dir";
    await seedBadged(slug, { "index.html": "<body></body>", "about/index.html": "<body></body>" });
    const { response, text } = await cold(slug, "/about");
    expect(response.status).toBe(301);
    expect(text).toBe("");
  });
});

describe("multi-file: the site's own 404 and the SPA shell get the badge once", () => {
  it("injects into the custom 404.html", async () => {
    const slug = "badge-404";
    await seedBadged(
      slug,
      { "index.html": "<body></body>", "404.html": "<body>gone</body>" },
      { has404: true },
    );
    const { response, text } = await cold(slug, "/nope.html");
    expect(response.status).toBe(404);
    expect(text).toBe(`<body>gone${badgeFor(slug, KEPT).html}</body>`);
  });

  it("injects into the SPA-rewritten shell", async () => {
    const slug = "badge-spa";
    await seedBadged(slug, { "index.html": "<body><div id=app></div></body>" }, { spa: true });
    const { response, text } = await cold(slug, "/dashboard/settings");
    expect(response.status).toBe(200);
    expect(text).toBe(`<body><div id=app></div>${badgeFor(slug, KEPT).html}</body>`);
  });
});

describe("composite ETag (Risk 1)", () => {
  it("answers with \"{r2etag}-{badgeHash}\"", async () => {
    const slug = "etag-composite";
    const m = await seedBadged(slug, { "index.html": "<body></body>" });
    const { response } = await cold(slug);
    const object = await env.KEPT_R2.head(`sites/${m.siteId}/${m.versionId}/index.html`);
    expect(response.headers.get("etag")).toBe(`"${object?.etag}-${badgeFor(slug, KEPT).badgeHash}"`);
  });

  it("304s on the current composite ETag, with the same ETag back", async () => {
    const slug = "etag-304";
    await seedBadged(slug, { "index.html": "<body></body>" });
    const first = await cold(slug);
    const etag = first.response.headers.get("etag") ?? "";
    const { response, text } = await cold(slug, "/", { headers: { "If-None-Match": etag } });
    expect(response.status, describeResponse(response, text)).toBe(304);
    expect(response.headers.get("etag")).toBe(etag);
    expect(text).toBe("");
  });

  it("serves a full 200 when only the badge changed (old hash)", async () => {
    const slug = "etag-badge-changed";
    await seedBadged(slug, { "index.html": "<body></body>" });
    const before = (await cold(slug)).response.headers.get("etag") ?? "";

    await seedBadged(slug, { "index.html": "<body></body>" }, { badge: { ...KEPT, model: "Opus" } });
    const { response, text } = await cold(slug, "/", { headers: { "If-None-Match": before } });
    expect(response.status, "a stale badge must never be pinned by a 304").toBe(200);
    expect(text).toContain("Made with Opus");
    expect(response.headers.get("etag")).not.toBe(before);
  });

  it("serves a full 200 to a bare R2 ETag cached before the badge existed", async () => {
    const slug = "etag-bare";
    const m = await seedBadged(slug, { "index.html": "<body></body>" });
    const object = await env.KEPT_R2.head(`sites/${m.siteId}/${m.versionId}/index.html`);
    const { response } = await cold(slug, "/", { headers: { "If-None-Match": object?.httpEtag ?? "" } });
    expect(response.status).toBe(200);
  });

  it("304s on a list containing the current composite ETag", async () => {
    const slug = "etag-list";
    await seedBadged(slug, { "index.html": "<body></body>" });
    const etag = (await cold(slug)).response.headers.get("etag") ?? "";
    const { response } = await cold(slug, "/", { headers: { "If-None-Match": `"stale", ${etag}` } });
    expect(response.status).toBe(304);
  });
});

describe("store budget (AC4)", () => {
  it("a badged page costs 1 KV + 1 R2 cold and 0 + 0 warm; the cache holds the badged bytes", async () => {
    const slug = "badge-budget";
    await seedBadged(slug, { "index.html": "<body></body>" });
    const request = requestFor(slug);
    await evictFromCache(request);
    const { env: counted, counts } = countingEnv();

    const first = await dispatchText(request, counted);
    expect(counts.kvGet, describeCounts(counts)).toBe(1);
    expect(counts.r2Get, describeCounts(counts)).toBe(1);

    const warm = await dispatchText(requestFor(slug), counted);
    expect(counts.kvGet, describeCounts(counts)).toBe(1);
    expect(counts.r2Get, describeCounts(counts)).toBe(1);
    expect(warm.text).toBe(first.text);
    expect(warm.text).toContain("<kept-badge>");
  });
});
