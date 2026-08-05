// Pipeline stage 3–4 — the single KV read and the exhaustive status branch
// (tasks 002 and 004).
//
// `live` is the ONLY status that returns content. Every other status returns a
// branded system page, and a manifest that fails `kvManifestSchema` returns the
// same 404 as a missing one — never a 500, because a half-written manifest is a
// genuine mid-publish race in E04, not an exceptional condition.

import { beforeAll, describe, expect, it } from "vitest";

import { MANIFEST_STATUSES, SITE_STATUSES } from "@kept/shared";

import { MANIFEST_KV_CACHE_TTL_SECONDS } from "../src/manifest";
import {
  countingEnv,
  describeCounts,
  describeResponse,
  dispatchText,
  evictFromCache,
  pageHtml,
  requestFor,
  seedRawManifest,
  seedSite,
  SERVING_STATUSES,
  SYSTEM_PAGE_TITLES,
} from "./fixtures";

/** status → { code, the page title it must render }. Confirmed 2026-08-03. */
const EXPECTED = {
  live: { code: 200, title: null },
  under_review: { code: 451, title: SYSTEM_PAGE_TITLES.suspended },
  quarantined: { code: 451, title: SYSTEM_PAGE_TITLES.suspended },
  expired: { code: 410, title: SYSTEM_PAGE_TITLES.expired },
  removed: { code: 404, title: SYSTEM_PAGE_TITLES.notFound },
} as const;

describe("manifest status matrix", () => {
  beforeAll(async () => {
    for (const status of SERVING_STATUSES) {
      // Every fixture has its R2 object present, so the only variable is status.
      await seedSite(`status-${status.replace(/_/g, "-")}`, { status });
    }
  });

  it("keeps the suite's status list identical to the serving contract", () => {
    expect(
      [...SERVING_STATUSES].sort(),
      "MANIFEST_STATUSES changed — every branch below must be reviewed, not just re-listed",
    ).toEqual([...MANIFEST_STATUSES].sort());
  });

  it("pins SITE_STATUSES — the pgEnum-bearing tuple", () => {
    // `SITE_STATUSES` is NOT `MANIFEST_STATUSES`. It drives the Drizzle
    // `pgEnum` in apps/web/lib/db/schema.ts, so changing it is a POSTGRES ENUM
    // MIGRATION, not a rename — a value may only be added or removed here
    // together with a generated migration in apps/web/drizzle/ that rewrites
    // the `site_status` type. Pinning the exact tuple means an "obvious
    // tidy-up" fails a test instead of producing a schema that no longer
    // matches the deployed database.
    //
    // E04's migration retired the last pre-pivot status this way. It had never
    // been in `MANIFEST_STATUSES`, so the serving contract did not move —
    // which is exactly the property this pair of tests exists to keep visible.
    expect(
      [...SITE_STATUSES],
      "SITE_STATUSES drives a Postgres enum — changing it without a generated enum-rewrite migration desynchronises the schema from the deployed database.",
    ).toEqual(["live", "under_review", "quarantined", "expired", "removed", "archived"]);
  });

  for (const status of SERVING_STATUSES) {
    const slug = `status-${status.replace(/_/g, "-")}`;
    const { code, title } = EXPECTED[status];

    it(`${status} → ${code}${title ? ` (${title})` : " (page content)"}`, async () => {
      const { response, text } = await dispatchText(requestFor(slug));

      expect(response.status, `status "${status}" must answer ${code}. Got ${describeResponse(response, text)}`).toBe(code);

      if (title === null) {
        expect(text, "`live` is the only status that returns the published bytes").toBe(pageHtml(slug));
      } else {
        expect(text, `status "${status}" must render the branded "${title}" page`).toContain(title);
        expect(text, `status "${status}" must NOT leak the published bytes`).not.toContain(`<h1>${slug}</h1>`);
      }
    });
  }

  it("makes `removed` indistinguishable from `never existed`", async () => {
    // A removed page must not be confirmable by its status code.
    const removed = await dispatchText(requestFor("status-removed"));
    const absent = await dispatchText(requestFor("never-published-at-all"));

    expect(removed.response.status, "removed must answer 404").toBe(404);
    expect(absent.response.status, "an unknown slug must answer 404").toBe(404);
    expect(
      removed.text,
      "the removed page and the unknown-slug page must be byte-identical, or the status code leaks",
    ).toBe(absent.text);
  });

  it("reads KV exactly once for a served page", async () => {
    const { env: counted, counts } = countingEnv();
    // A sibling test already served this URL; evict it so this really is cold.
    await evictFromCache(requestFor("status-live"));
    await dispatchText(requestFor("status-live"), counted);

    expect(counts.kvGet, `the cold-request budget is one KV read — ${describeCounts(counts)}`).toBe(1);
    expect(counts.kvKeys, "the KV key is the bare slug, never a prefixed or suffixed form").toEqual(["status-live"]);
  });

  it("passes cacheTtl from the exported constant, not a literal", async () => {
    // INVISIBLE FROM EVERY OTHER ANGLE. `cacheTtl` places the manifest in
    // Cloudflare's own KV edge cache, so it is the primary lever on KV read
    // cost — and it is also the propagation floor for a moderation status flip,
    // because a KV *write* does not invalidate a `cacheTtl` entry. Dropping it,
    // or hardcoding a number here that drifts from
    // `MANIFEST_KV_CACHE_TTL_SECONDS`, changes both of those and changes
    // nothing a response can show: same status, same headers, same bytes.
    //
    // The key-only counter could not see this, which is why `kvOptions` exists.
    // Asserted against the exported constant rather than against `60`, so
    // deliberately retuning the value stays a one-line change while silently
    // losing the option does not.
    const { env: counted, counts } = countingEnv();
    await evictFromCache(requestFor("status-live"));
    await dispatchText(requestFor("status-live"), counted);

    expect(counts.kvGet, `fixture sanity: exactly one KV read to inspect — ${describeCounts(counts)}`).toBe(1);
    expect(
      counts.kvOptions[0],
      `the KV read must ask for text and carry cacheTtl=MANIFEST_KV_CACHE_TTL_SECONDS. Without it every cold request in a colo pays a fresh KV read; with a different number the documented moderation-propagation floor is wrong. — ${describeCounts(counts)}`,
    ).toEqual({ type: "text", cacheTtl: MANIFEST_KV_CACHE_TTL_SECONDS });

    expect(
      MANIFEST_KV_CACHE_TTL_SECONDS,
      "60s is Cloudflare's minimum accepted cacheTtl, and it sits at the minimum on purpose: moderation latency outranks KV read cost. Raising it raises the worst-case delay before a quarantine takes effect.",
    ).toBe(60);
  });

  it("reads KV exactly once for a non-live status and never touches R2", async () => {
    const { env: counted, counts } = countingEnv();
    await evictFromCache(requestFor("status-quarantined"));
    await dispatchText(requestFor("status-quarantined"), counted);

    expect(counts.kvGet, `one KV read — ${describeCounts(counts)}`).toBe(1);
    expect(counts.r2Get, `a suspended page must not pay for an R2 read — ${describeCounts(counts)}`).toBe(0);
  });
});

describe("unservable KV values", () => {
  const malformed: { name: string; slug: string; raw: string }[] = [
    {
      name: "a value that is not JSON at all",
      slug: "bad-not-json",
      raw: "{ this is not json",
    },
    {
      name: "valid JSON that is not an object",
      slug: "bad-json-array",
      raw: "[1,2,3]",
    },
    {
      name: "an object missing required fields (a half-written publish)",
      slug: "bad-partial",
      raw: JSON.stringify({ siteId: "site-x" }),
    },
    {
      name: "an object with a status outside the serving contract",
      slug: "bad-status",
      raw: JSON.stringify({
        siteId: "site-x",
        versionId: "v1",
        status: "archived",
        region: "auto",
        ownerId: null,
        updatedAt: 1,
      }),
    },
    {
      name: "an object with the wrong type for updatedAt",
      slug: "bad-updated-at",
      raw: JSON.stringify({
        siteId: "site-x",
        versionId: "v1",
        status: "live",
        region: "auto",
        ownerId: null,
        updatedAt: "yesterday",
      }),
    },
    {
      name: "an object with an unknown region",
      slug: "bad-region",
      raw: JSON.stringify({
        siteId: "site-x",
        versionId: "v1",
        status: "live",
        region: "mars",
        ownerId: null,
        updatedAt: 1,
      }),
    },
  ];

  beforeAll(async () => {
    for (const { slug, raw } of malformed) {
      await seedRawManifest(slug, raw);
    }
  });

  for (const { name, slug } of malformed) {
    it(`returns the branded 404 — not a 500 — for ${name}`, async () => {
      const { env: counted, counts } = countingEnv();
      const { response, text } = await dispatchText(requestFor(slug), counted);

      expect(response.status, `${name} must be a branded 404. Got ${describeResponse(response, text)}`).toBe(404);
      expect(text, `${name} must render the branded notFound page`).toContain(SYSTEM_PAGE_TITLES.notFound);
      expect(counts.r2Get, `an unservable manifest must not reach R2 for a page object — ${describeCounts(counts)}`).toBe(0);
    });
  }
});
