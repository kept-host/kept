// Pipeline stage 5–6 — request path → R2 key → the single R2 read (task 003).
//
// R2 keys are a flat namespace and the key is `sites/{siteId}/{versionId}/{path}`,
// so an unnormalized request path concatenated into a key is a probe against
// every other tenant's objects. Each hostile path is asserted for the 404 AND
// for the read count — asserting only the status would pass even if the Worker
// had already asked R2 for `sites/site-a/v1/../../site-b/v1/index.html`.
//
// Dot-segment traversal gets its own group: the WHATWG URL parser removes `..`
// (including its `%2e%2e` form) during parsing, so at the HTTP layer the guard
// is unreachable by that vector. That group measures the normalization rather
// than assuming it, and asserts `resolvePath` directly with the raw strings the
// parser never lets through — it is the layer that has to hold if a path ever
// arrives un-normalized.

import { beforeAll, describe, expect, it } from "vitest";

import { MAX_REQUEST_PATH_BYTES, resolvePath } from "../src/r2";
import {
  countingEnv,
  describeCounts,
  describeResponse,
  dispatchText,
  evictFromCache,
  manifest,
  objectKey,
  pageHtml,
  requestFor,
  seedManifest,
  seedObject,
  seedSite,
  SYSTEM_PAGE_TITLES,
} from "./fixtures";

const SLUG = "path-guard";
const VICTIM = "other-tenant";

describe("R2 key construction and the traversal guard", () => {
  beforeAll(async () => {
    await seedSite(SLUG);
    // A second tenant's object, so a successful traversal would be *visible* as
    // the wrong body rather than merely as a 404.
    await seedSite(VICTIM);
  });

  it("builds the key as sites/{siteId}/{versionId}/{path} and reads it exactly once", async () => {
    const { env: counted, counts } = countingEnv();
    const { response, text } = await dispatchText(requestFor(SLUG, "/"), counted);

    expect(response.status, `expected 200, got ${describeResponse(response, text)}`).toBe(200);
    expect(counts.r2Get, `the cold-request budget is one R2 read — ${describeCounts(counts)}`).toBe(1);
    expect(counts.r2Keys, "a bare `/` must resolve to the index document under the manifest's own prefix").toEqual([
      `sites/site-${SLUG}/v1/index.html`,
    ]);
  });

  it("resolves a directory-shaped path to its index document", async () => {
    const m = manifest({ siteId: `site-${SLUG}-dir` });
    await seedObject(m, "<p>nested index</p>", "docs/index.html");
    await seedManifest(`${SLUG}-dir`, m);

    const { env: counted, counts } = countingEnv();
    const { response, text } = await dispatchText(requestFor(`${SLUG}-dir`, "/docs/"), counted);

    expect(response.status, `expected 200 for a trailing-slash path, got ${describeResponse(response, text)}`).toBe(200);
    expect(text, "a trailing-slash path must serve that directory's index.html").toBe("<p>nested index</p>");
    expect(counts.r2Keys, "trailing slash appends index.html, it does not strip the segment").toEqual([
      objectKey(m, "docs/index.html"),
    ]);
  });

  it("returns the branded 404 when the manifest points at an object that is not there", async () => {
    // The common case, not an exceptional one: a versionId whose object was
    // never written, or was already purged.
    await seedManifest("dangling", manifest({ siteId: "site-dangling", versionId: "v-never-written" }));

    const { env: counted, counts } = countingEnv();
    const { response, text } = await dispatchText(requestFor("dangling"), counted);

    expect(response.status, `a dangling manifest must be a branded 404, got ${describeResponse(response, text)}`).toBe(404);
    expect(text, "a dangling manifest must render the branded notFound page").toContain(SYSTEM_PAGE_TITLES.notFound);
    expect(counts.r2Get, `the miss must still be exactly one R2 read, not a head+get pair — ${describeCounts(counts)}`).toBe(1);
  });

  describe("hostile paths — branded 404, zero R2 reads, never a 5xx", () => {
    const longPath = `/${"a".repeat(8 * 1024)}.html`;

    const cases: { name: string; path: string; why: string }[] = [
      {
        name: "a percent-encoded backslash",
        path: "/%5Cwindows%5Cstyle.html",
        why: "backslash is a path separator on enough storage systems to refuse outright rather than reason about",
      },
      {
        name: "a null byte",
        path: "/index%00.html",
        why: "NUL and the other C0 control characters have no place in an R2 key",
      },
      {
        name: "a C1-range control character",
        path: "/index%1f.html",
        why: "the whole C0/DEL range is refused, not just NUL",
      },
      {
        name: `an ${8}KB request path (limit is ${MAX_REQUEST_PATH_BYTES} bytes)`,
        path: longPath,
        why: "the length check runs before decoding, so an oversized path never allocates a decode",
      },
      {
        name: "a malformed percent-escape",
        path: "/%zz.html",
        why: "decodeURIComponent throws URIError on a bad escape; that is a rejection value, not a 500",
      },
      {
        name: "a truncated percent-escape",
        path: "/index%.html",
        why: "same URIError path, different shape",
      },
      {
        name: "an invalid UTF-8 byte sequence",
        path: "/%c3%28.html",
        why: "decodeURIComponent throws on invalid UTF-8 too",
      },
    ];

    for (const { name, path, why } of cases) {
      it(`rejects ${name} without reaching R2`, async () => {
        const { env: counted, counts } = countingEnv();
        const { response, text } = await dispatchText(requestFor(SLUG, path), counted);

        expect(response.status, `${path.slice(0, 80)} — ${why}. Got ${describeResponse(response, text)}`).toBe(404);
        expect(text, `${name} must render the branded notFound page`).toContain(SYSTEM_PAGE_TITLES.notFound);
        expect(text, "the offending path must never be echoed back into the response body").not.toContain(
          path.slice(1, 40),
        );
        expect(counts.r2Get, `${name} must never reach KEPT_R2.get — ${describeCounts(counts)}`).toBe(0);
      });
    }

    it("never returns a 5xx for any hostile path", async () => {
      for (const { name, path } of cases) {
        const { response } = await dispatchText(requestFor(SLUG, path));
        expect(response.status, `${name} produced a server error: ${describeResponse(response)}`).toBeLessThan(500);
      }
    });

  });

  describe("dot-segment traversal", () => {
    // MEASURED, not assumed: the WHATWG URL parser treats `%2e%2e` as a
    // double-dot path segment and REMOVES it during parsing, so by the time the
    // Worker reads `url.pathname` the `..` is already gone. A traversal
    // therefore arrives as an ordinary deep path, and the honest HTTP-level
    // claim is "it cannot reach another tenant's bytes", not "it never reaches
    // R2". `resolvePath`'s own guard is asserted directly below, because it is
    // the layer that has to hold if a path ever arrives un-normalized.
    const TRAVERSAL = `/%2e%2e/%2e%2e/sites/site-${VICTIM}/v1/index.html`;

    it("is normalized away by the runtime before the Worker sees it", () => {
      const pathname = new URL(TRAVERSAL, "https://example.test").pathname;

      expect(pathname, `the runtime left a ".." segment in ${pathname} — the HTTP-level expectations below must be revisited`).not.toContain("..");
    });

    it("cannot be made to serve another tenant's bytes", async () => {
      const { response, text } = await dispatchText(requestFor(SLUG, TRAVERSAL));

      expect(response.status, `a traversal must not resolve to a readable object, got ${describeResponse(response)}`).toBe(404);
      expect(text, "a traversal must never return the victim tenant's page body").not.toContain(pageHtml(VICTIM));
    });

    it("stays inside this manifest's own prefix even after normalization", async () => {
      const { env: counted, counts } = countingEnv();
      // A sibling test served this URL; without the eviction a cache hit would
      // record zero keys and this assertion would pass vacuously.
      await evictFromCache(requestFor(SLUG, TRAVERSAL));
      await dispatchText(requestFor(SLUG, TRAVERSAL), counted);

      expect(counts.r2Keys.length, `the traversal must actually reach R2 for this assertion to mean anything — ${describeCounts(counts)}`).toBe(1);
      for (const key of counts.r2Keys) {
        expect(key, `the Worker asked R2 for ${key}, which is outside sites/site-${SLUG}/ — ${describeCounts(counts)}`).toMatch(
          new RegExp(`^sites/site-${SLUG}/`),
        );
      }
    });

    // The guard itself, fed the raw strings the URL parser never lets through.
    // This is the defence-in-depth layer: R2 keys are a flat namespace, so a
    // `..` reaching the concatenation would be a cross-tenant probe.
    const rejected: { name: string; pathname: string }[] = [
      { name: "a leading ../ traversal", pathname: "/../../sites/other/v1/index.html" },
      { name: "an interior .. segment", pathname: "/docs/../../secret.html" },
      { name: "a trailing .. segment", pathname: "/docs/.." },
      { name: "an encoded .. that survives one decode", pathname: "/%2e%2e/x.html" },
      { name: "a raw backslash", pathname: "/windows\\style.html" },
      { name: "a raw NUL", pathname: "/index\u0000.html" },
      { name: "a DEL character", pathname: "/index\u007f.html" },
      { name: "a lone surrogate", pathname: "/index\ud800.html" },
      { name: "a malformed escape", pathname: "/%zz.html" },
      { name: `a path over ${MAX_REQUEST_PATH_BYTES} bytes`, pathname: `/${"a".repeat(MAX_REQUEST_PATH_BYTES)}` },
    ];

    for (const { name, pathname } of rejected) {
      it(`resolvePath rejects ${name} as a value, never a throw`, () => {
        expect(resolvePath(pathname), `resolvePath(${JSON.stringify(pathname)}) must reject`).toEqual({
          kind: "rejected",
        });
      });
    }

    const accepted: { name: string; pathname: string; path: string }[] = [
      { name: "the root", pathname: "/", path: "index.html" },
      { name: "an empty path", pathname: "", path: "index.html" },
      { name: "a directory", pathname: "/docs/", path: "docs/index.html" },
      { name: "a file", pathname: "/about.html", path: "about.html" },
      { name: "a single dot segment", pathname: "/./about.html", path: "./about.html" },
      { name: "a path at exactly the byte limit", pathname: `/${"a".repeat(MAX_REQUEST_PATH_BYTES - 1)}`, path: "a".repeat(MAX_REQUEST_PATH_BYTES - 1) },
    ];

    for (const { name, pathname, path } of accepted) {
      it(`resolvePath accepts ${name}`, () => {
        expect(resolvePath(pathname), `resolvePath(${JSON.stringify(pathname.slice(0, 40))}) must resolve`).toEqual({
          kind: "path",
          path,
        });
      });
    }
  });
});
