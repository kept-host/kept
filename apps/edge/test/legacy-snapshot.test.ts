// A pre-E08 manifest serves exactly as `dev-v0.8.0` did (E08 AC23).
//
// E08 adds two optional manifest flags (`spa`, `has404`) and the branches that
// read them. A manifest written before E08 carries neither, and every page kept
// before E08 has one — so the Worker's answer to that shape must not move by a
// byte. The snapshot beside this file was RECORDED ON `develop` (= `dev-v0.8.0`
// for `apps/edge`) before any E08 edge change, and is committed: a diff here
// means an old page now serves differently, which is a regression, not a
// snapshot to update.
//
// What is pinned: status, every header (name and value) and the body, for the
// root, `/index.html`, an asset, a miss, a traversal attempt and a conditional
// request. The branded 404's own markup is compared against `renderSystemPage`
// rather than snapshotted, because E08 D16 deliberately changes its font names
// (and `system-pages.test.ts` pins those bytes); what this file guards is that
// an old manifest still REACHES that page, with the same status and headers.
//
// Not pinned: `/about` where `about/index.html` exists. E08 Q-new-6 makes that
// a 301 to `/about/` on every non-SPA site, old manifests included — a
// deliberate change, owned by `multi-file.test.ts`.

import { describe, expect, it } from "vitest";

import { renderSystemPage } from "../src/system-pages";
import {
  APEX_ORIGIN,
  dispatchText,
  evictFromCache,
  manifest,
  requestFor,
  seedManifest,
  seedObject,
} from "./fixtures";

const SLUG = "legacy-page";

/** Today's shape, spelled out: no `spa`, no `has404`. Fixed, so ETags are stable. */
const LEGACY = manifest({ siteId: "site-legacy", versionId: "v-legacy" });

const PAGE = "<!doctype html><html><head><title>legacy</title></head><body><h1>kept</h1></body></html>";
const ASSET = "console.log('legacy');";

const NOT_FOUND_BODY = renderSystemPage("notFound", { apexOrigin: APEX_ORIGIN }).body;

async function seedLegacy(): Promise<void> {
  await seedObject(LEGACY, PAGE);
  await seedObject(LEGACY, ASSET, "app.js");
  await seedManifest(SLUG, LEGACY);
}

/** Status, every header sorted by name, and the body — the whole response. */
async function record(path: string, init?: RequestInit) {
  const request = requestFor(SLUG, path, init);
  await evictFromCache(request);
  const { response, text } = await dispatchText(request);
  const headers = [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b));
  const body = text === NOT_FOUND_BODY ? "<branded notFound page>" : text;
  return { status: response.status, headers, body };
}

describe("a manifest without spa/has404 serves byte-identically to dev-v0.8.0 (AC23)", () => {
  const cases: { name: string; path: string }[] = [
    { name: "the root", path: "/" },
    { name: "/index.html", path: "/index.html" },
    { name: "an asset", path: "/app.js" },
    { name: "a miss", path: "/missing.html" },
    { name: "an extensionless miss", path: "/dashboard/settings" },
    { name: "a traversal attempt", path: "/..%2F..%2Fsites%2Fother%2Fv1%2Findex.html" },
  ];

  for (const { name, path } of cases) {
    it(`${name} (${path})`, async () => {
      await seedLegacy();
      expect(await record(path)).toMatchSnapshot();
    });
  }

  it("a conditional request for the root", async () => {
    await seedLegacy();
    const first = await record("/");
    const etag = first.headers.find(([name]) => name === "etag")?.[1];
    expect(etag, "fixture sanity: the root must carry an ETag").toBeDefined();

    expect(await record("/", { headers: { "If-None-Match": etag ?? "" } })).toMatchSnapshot();
  });
});
