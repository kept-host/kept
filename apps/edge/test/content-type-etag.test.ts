// Content-Type, ETag and conditional requests (task 003).
//
// TRUST BOUNDARY: every byte in R2 was uploaded by a stranger, and so was the
// `httpMetadata.contentType` R2 stores alongside it. A publisher-chosen content
// type is a stored-XSS vector against the serving origin, so the Worker answers
// with a type derived from the extension of a key IT constructed. Every fixture
// here is deliberately stored with a wrong content type to prove that.

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

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
  seedSite,
} from "./fixtures";

const SLUG = "typed-page";

describe("Content-Type is the Worker's, never the uploader's", () => {
  beforeAll(async () => {
    await seedSite(SLUG);
  });

  it("serves HTML as text/html; charset=utf-8 despite the stored content type", async () => {
    const { response, text } = await dispatchText(requestFor(SLUG));

    expect(response.status, `expected 200, got ${describeResponse(response, text)}`).toBe(200);
    expect(
      response.headers.get("content-type"),
      "the seeded object carries `application/x-uploader-chosen`; echoing it back would be a stored-XSS vector",
    ).toBe("text/html; charset=utf-8");
  });

  const typed: { path: string; contentType: string }[] = [
    { path: "styles.css", contentType: "text/css; charset=utf-8" },
    { path: "app.js", contentType: "text/javascript; charset=utf-8" },
    { path: "data.json", contentType: "application/json; charset=utf-8" },
    { path: "notes.txt", contentType: "text/plain; charset=utf-8" },
    { path: "logo.svg", contentType: "image/svg+xml" },
    { path: "shot.png", contentType: "image/png" },
    { path: "font.woff2", contentType: "font/woff2" },
    // Unmapped and extensionless keys are opaque bytes, never a guess.
    { path: "archive.tar.gz", contentType: "application/octet-stream" },
    { path: "LICENSE", contentType: "application/octet-stream" },
  ];

  for (const { path, contentType } of typed) {
    it(`derives ${contentType} from the key extension of ${path}`, async () => {
      const slug = `typed-${path.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
      const m = manifest({ siteId: `site-${slug}` });
      await seedObject(m, "payload", path);
      await seedManifest(slug, m);

      const response = await dispatch(requestFor(slug, `/${path}`));

      expect(response.status, `expected 200 for /${path}, got ${describeResponse(response)}`).toBe(200);
      expect(
        response.headers.get("content-type"),
        `/${path} must be typed from the extension of the key the Worker built, not from R2 metadata`,
      ).toBe(contentType);
    });
  }
});

// WHY THIS GROUP IS LARGER THAN "does a 304 come back".
//
// `ETag` is answered with R2's `httpEtag`, which is QUOTED, so a browser sends
// those exact quoted bytes back in `If-None-Match` — and R2's `onlyIf` wants the
// BARE etag and rejects a quoted one with `TypeError: Conditional ETag should
// not be quoted`. Forwarding the header raw therefore turned every revalidation
// of a cached page into a branded 404: a permanent page looking deleted the
// moment a visitor's browser checked on it. This suite caught that, and
// `r2.ts`'s `parseIfNoneMatch` now normalises the header at the boundary.
//
// The header's other legal shapes go through that same parser, and each takes a
// DIFFERENT branch: a single etag is pushed into `onlyIf`, while a list and `*`
// cannot be (workerd rejects an array at runtime) and are settled after the
// fetch against the object already in hand. They are covered individually below,
// because "the common case works" is exactly what was true before the bug.
describe("ETag and conditional requests", () => {
  const CONDITIONAL = "conditional-page";
  let etag: string;

  beforeAll(async () => {
    const m = await seedSite(CONDITIONAL);
    const head = await env.KEPT_R2.head(objectKey(m));
    if (head === null) throw new Error(`fixture not seeded: ${objectKey(m)}`);
    etag = head.httpEtag;
  });

  it("returns R2's own httpEtag so the next request can be conditional", async () => {
    const response = await dispatch(requestFor(CONDITIONAL));

    expect(response.status, `expected 200, got ${describeResponse(response)}`).toBe(200);
    expect(response.headers.get("etag"), "ETag must be R2's httpEtag verbatim — a Worker-invented value would not match onlyIf").toBe(etag);
  });

  it("answers 304 with an empty body when If-None-Match matches, in one R2 read", async () => {
    const { env: counted, counts } = countingEnv();
    // A sibling test already cached this URL. Evict it so the conditional is
    // answered by R2's `onlyIf` — the thing under test — rather than by a cache
    // hit that would report zero R2 reads and pass for the wrong reason.
    await evictFromCache(requestFor(CONDITIONAL));
    const response = await dispatch(
      requestFor(CONDITIONAL, "/", { headers: { "If-None-Match": etag } }),
      counted,
    );
    const body = await response.text();

    expect(response.status, `a matching If-None-Match must be 304, got ${describeResponse(response, body)}`).toBe(304);
    expect(body, "a 304 must transfer no body").toBe("");
    expect(response.headers.get("etag"), "a 304 must still carry the ETag it matched").toBe(etag);
    expect(
      counts.r2Get,
      `the conditional is pushed into R2's onlyIf, so it stays one operation — ${describeCounts(counts)}`,
    ).toBe(1);
  });

  it("answers 200 with the full body when If-None-Match does not match", async () => {
    await evictFromCache(requestFor(CONDITIONAL));
    const { response, text } = await dispatchText(
      requestFor(CONDITIONAL, "/", { headers: { "If-None-Match": '"a-stale-etag"' } }),
    );

    expect(response.status, `a stale If-None-Match must re-send the page, got ${describeResponse(response, text)}`).toBe(200);
    expect(text, "the re-sent body must be the current page").toBe(pageHtml(CONDITIONAL));
    expect(response.headers.get("etag"), "the 200 must carry the current ETag so the client can re-validate next time").toBe(etag);
  });

  it("honours the weak form W/\"…\" a proxy may rewrite the header into", async () => {
    // `If-None-Match` is defined to use weak comparison, and an intermediary is
    // free to weaken a strong etag. R2 only ever mints strong ones, so the weak
    // form is the same value in different clothing and must still match.
    await evictFromCache(requestFor(CONDITIONAL));
    const { response, text } = await dispatchText(
      requestFor(CONDITIONAL, "/", { headers: { "If-None-Match": `W/${etag}` } }),
    );

    expect(response.status, `a weak-form conditional must still be 304, got ${describeResponse(response, text)}`).toBe(304);
    expect(text, "a 304 must transfer no body").toBe("");
  });

  it("matches any member of a comma-separated If-None-Match list", async () => {
    // A list cannot be pushed into `onlyIf` (workerd rejects an array), so this
    // exercises the post-fetch settle path — including the `body.cancel()` that
    // must not leave a stream dangling. Still exactly one R2 operation.
    const { env: counted, counts } = countingEnv();
    await evictFromCache(requestFor(CONDITIONAL));
    const { response, text } = await dispatchText(
      requestFor(CONDITIONAL, "/", { headers: { "If-None-Match": `"a-stale-etag", ${etag}` } }),
      counted,
    );

    expect(response.status, `a list containing the current etag must be 304, got ${describeResponse(response, text)}`).toBe(304);
    expect(text, "a 304 must transfer no body").toBe("");
    expect(response.headers.get("etag"), "the 304 must carry the etag that matched").toBe(etag);
    expect(
      counts.r2Get,
      `settling a list after the fetch must still cost one R2 operation, not two — ${describeCounts(counts)}`,
    ).toBe(1);
  });

  it("re-sends the page when no member of the list matches", async () => {
    await evictFromCache(requestFor(CONDITIONAL));
    const { response, text } = await dispatchText(
      requestFor(CONDITIONAL, "/", { headers: { "If-None-Match": '"stale-one", "stale-two"' } }),
    );

    expect(response.status, `a list of stale etags must re-send the page, got ${describeResponse(response, text)}`).toBe(200);
    expect(text, "the re-sent body must be the current page").toBe(pageHtml(CONDITIONAL));
  });

  it("treats If-None-Match: * as a match, because a representation exists", async () => {
    await evictFromCache(requestFor(CONDITIONAL));
    const { response, text } = await dispatchText(
      requestFor(CONDITIONAL, "/", { headers: { "If-None-Match": "*" } }),
    );

    expect(response.status, `* must be 304 when the object exists, got ${describeResponse(response, text)}`).toBe(304);
    expect(text, "a 304 must transfer no body").toBe("");
  });

  it("ignores an empty If-None-Match instead of erroring on it", async () => {
    await evictFromCache(requestFor(CONDITIONAL));
    const { response, text } = await dispatchText(
      requestFor(CONDITIONAL, "/", { headers: { "If-None-Match": "  " } }),
    );

    expect(
      response.status,
      `a blank conditional must be treated as no condition and serve the page, got ${describeResponse(response, text)}`,
    ).toBe(200);
    expect(text, "the page must be served in full").toBe(pageHtml(CONDITIONAL));
  });

  it("changes the ETag when the page bytes change", async () => {
    const m = manifest({ siteId: `site-${CONDITIONAL}-v2`, versionId: "v2" });
    await seedObject(m, "<p>replaced</p>");
    await seedManifest(`${CONDITIONAL}-v2`, m);

    const response = await dispatch(requestFor(`${CONDITIONAL}-v2`));
    const replacedEtag = response.headers.get("etag");

    expect(replacedEtag, "a replaced version must not reuse the previous ETag").not.toBe(etag);
    expect(replacedEtag, "a served object must always carry an ETag").toBeTruthy();
  });
});
