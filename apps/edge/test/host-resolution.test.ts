// Pipeline stage 1 — host → slug (task 001).
//
// The contract this file defends: host resolution runs BEFORE any store access,
// so every rejection and every redirect costs zero KV reads and zero R2 reads.
// Each case therefore asserts the status code AND the read count; a future
// refactor that reads KV first would still return 404 and would still be a bug.

import { beforeAll, describe, expect, it } from "vitest";

import { RESERVED_LABELS, resolveHost } from "../src/host";
import {
  APEX_ORIGIN,
  BASE_DOMAIN,
  countingEnv,
  describeCounts,
  describeResponse,
  dispatch,
  dispatchText,
  pageHtml,
  requestUrl,
  seedSite,
  SYSTEM_PAGE_TITLES,
} from "./fixtures";

const SLUG = "quiet-harbor";

describe("host → slug resolution", () => {
  beforeAll(async () => {
    await seedSite(SLUG);
  });

  describe("hosts that resolve to a slug", () => {
    it("serves the page for a plain valid slug host", async () => {
      const { response, text } = await dispatchText(
        requestUrl(`https://${SLUG}.${BASE_DOMAIN}/`),
      );

      expect(response.status, `expected 200 for ${SLUG}.${BASE_DOMAIN}, got ${describeResponse(response, text)}`).toBe(200);
      expect(text, "the served body must be this slug's seeded page").toBe(pageHtml(SLUG));
    });

    it("normalizes an UPPERCASE host to the same slug", async () => {
      const { response, text } = await dispatchText(
        requestUrl(`https://${SLUG.toUpperCase()}.${BASE_DOMAIN.toUpperCase()}/`),
      );

      expect(response.status, `uppercase host must normalize, got ${describeResponse(response, text)}`).toBe(200);
      expect(text, "uppercase host must serve the identical page").toBe(pageHtml(SLUG));
    });

    it("ignores an explicit :port on the host", async () => {
      const { response, text } = await dispatchText(
        requestUrl(`https://${SLUG}.${BASE_DOMAIN}:8787/`),
      );

      expect(response.status, `host with :port must resolve, got ${describeResponse(response, text)}`).toBe(200);
      expect(text, "host with :port must serve the identical page").toBe(pageHtml(SLUG));
    });

    it("accepts a trailing-dot FQDN", async () => {
      // A fully-qualified `slug.base.` is a legal host and some clients send it.
      // `normalizeHost` strips exactly one trailing dot.
      const request = requestUrl(`https://${SLUG}.${BASE_DOMAIN}./`);
      const hostname = new URL(request.url).hostname;
      const { response, text } = await dispatchText(request);

      expect(response.status, `trailing-dot FQDN (runtime hostname=${JSON.stringify(hostname)}) must resolve, got ${describeResponse(response, text)}`).toBe(200);
      expect(text, "trailing-dot FQDN must serve the identical page").toBe(pageHtml(SLUG));
    });
  });

  describe("hosts that are invalid — branded 404 at zero store cost", () => {
    const cases: { name: string; url: string; why: string }[] = [
      {
        name: "a multi-label host",
        url: `https://deep.${SLUG}.${BASE_DOMAIN}/`,
        why: "`a.b.{base}` must NOT be read as a slug of `a` — the first label only rule is what stops a nested host serving somebody else's page",
      },
      {
        name: "a host on the wrong base domain",
        url: `https://${SLUG}.example.invalid/`,
        why: "the base domain arrives as a var; a host outside it means the environment is misconfigured and must fail loudly, never serve",
      },
      {
        name: "the bare base domain with no label",
        url: `https://${BASE_DOMAIN}/`,
        why: "the apex is the control plane's, not the serve plane's",
      },
      {
        name: "an over-long label (64 chars, DNS allows 63)",
        url: `https://${"a".repeat(64)}.${BASE_DOMAIN}/`,
        why: "an unbounded label must never reach KEPT_KV.get",
      },
      {
        name: "a label with a percent-encoded dot",
        url: `https://a%2eb.${BASE_DOMAIN}/`,
        why: "percent-encoding in a host must not smuggle a label separator past the suffix check",
      },
      {
        name: "a label with an underscore",
        url: `https://not_a_slug.${BASE_DOMAIN}/`,
        why: "underscore is legal in a URL host but is not a legal slug character",
      },
      {
        name: "a label with a leading hyphen",
        url: `https://-leading.${BASE_DOMAIN}/`,
        why: "a slug is a DNS label: interior hyphens only",
      },
    ];

    for (const { name, url, why } of cases) {
      it(`returns the branded 404 for ${name}, reading no store`, async () => {
        const { env: counted, counts } = countingEnv();
        const { response, text } = await dispatchText(requestUrl(url), counted);

        expect(response.status, `${url} — ${why}. Got ${describeResponse(response, text)}`).toBe(404);
        expect(text, `${url} must render the branded notFound page, not a raw error`).toContain(
          SYSTEM_PAGE_TITLES.notFound,
        );
        expect(counts.kvGet, `${url} must cost zero KV reads — ${describeCounts(counts)}`).toBe(0);
        expect(counts.r2Get, `${url} must cost zero R2 reads — ${describeCounts(counts)}`).toBe(0);
      });
    }

    it("never returns a 5xx for any invalid host", async () => {
      for (const { url } of cases) {
        const response = await dispatch(requestUrl(url));
        expect(response.status, `${url} produced a server error: ${describeResponse(response)}`).toBeLessThan(500);
      }
    });
  });

  describe("reserved control-plane labels", () => {
    it("covers exactly www, api and assets — app belongs to the control plane", () => {
      expect([...RESERVED_LABELS].sort(), "the reserved set is a serving contract; adding one is a deliberate change").toEqual([
        "api",
        "assets",
        "www",
      ]);
    });

    for (const label of RESERVED_LABELS) {
      it(`301s ${label}.${BASE_DOMAIN} to the apex, preserving path and query, at zero store cost`, async () => {
        const { env: counted, counts } = countingEnv();
        const response = await dispatch(
          requestUrl(`https://${label}.${BASE_DOMAIN}/pricing/plans?ref=nav&x=1`),
          counted,
        );

        expect(response.status, `${label} must be a permanent redirect, got ${describeResponse(response)}`).toBe(301);
        expect(
          response.headers.get("location"),
          `${label} must redirect to KEPT_APEX_ORIGIN with the path and query intact`,
        ).toBe(`${APEX_ORIGIN}/pricing/plans?ref=nav&x=1`);
        expect(counts.kvGet, `${label} must cost zero KV reads — ${describeCounts(counts)}`).toBe(0);
        expect(counts.r2Get, `${label} must cost zero R2 reads — ${describeCounts(counts)}`).toBe(0);
      });
    }

    it("redirects a reserved label even when a KV manifest exists for it", async () => {
      // Defence in depth: the redirect must be decided from the host alone,
      // before KV is consulted, so a stray manifest cannot publish a page at
      // `www.{base}` and impersonate the control plane.
      await seedSite("www");

      const { env: counted, counts } = countingEnv();
      const response = await dispatch(requestUrl(`https://www.${BASE_DOMAIN}/`), counted);

      expect(response.status, `a manifest at "www" must not defeat the redirect, got ${describeResponse(response)}`).toBe(301);
      expect(counts.kvGet, `the redirect must still read no KV — ${describeCounts(counts)}`).toBe(0);
    });
  });

  describe("`app` is the control plane, not a reserved serving label (E05a)", () => {
    it("resolves app.{base} as a slug, so the Worker never 301s the control plane away", () => {
      expect(
        resolveHost(`app.${BASE_DOMAIN}`, BASE_DOMAIN),
        "`app.{base}` is answered by the control plane on a DNS-only record; reserving it here would 301 sign-in away from its own hostname",
      ).toEqual({ kind: "slug", slug: "app" });
    });

    it("serves the branded 404 for an accidentally re-proxied app.{base}, never user content", async () => {
      // The safety net: `app` stays in the control plane's RESERVED_SLUGS
      // (apps/web/lib/publish/slug.ts), so no page can ever be minted at this
      // slug. A re-proxied record therefore misses the manifest and gets the
      // branded 404 rather than somebody's uploaded HTML.
      const { response, text } = await dispatchText(requestUrl(`https://app.${BASE_DOMAIN}/`));

      expect(response.status, `app.${BASE_DOMAIN} must miss the manifest, got ${describeResponse(response, text)}`).toBe(404);
      expect(text, "an unclaimable slug must render the branded notFound page").toContain(
        SYSTEM_PAGE_TITLES.notFound,
      );
    });
  });
});
