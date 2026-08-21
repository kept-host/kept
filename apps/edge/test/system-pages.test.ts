// The branded system pages: their markup contract (task 004).
//
// THE CLAIM UNDER TEST IS THE EPIC'S PREMISE, NOT A COSMETIC ONE. `apps/edge`
// exists so that a hosted page keeps serving when everything else is down, and
// the pages a visitor sees when something is *wrong* are exactly the ones most
// likely to be rendered during an outage. A Google Fonts `<link>`, a CDN
// stylesheet or a remote image on the 404 path would mean the error page — the
// one shown when the control plane is unreachable, when R2 has no object, when
// a moderator has just quarantined a slug — depends on a third party being up.
// `system-pages.ts` says "ZERO EXTERNAL REQUESTS" in a comment; nothing until
// now made that statement fail if it stopped being true.
//
// So this file scans the rendered bytes for anything that would cost the
// browser a request: `<link>`, `<script src>`, any `src=` at all, a remote
// `url()` in the CSS, an `@import`. Inline `data:` URIs are fine — they are
// bytes, not requests.
//
// It scans BOTH the direct `renderSystemPage` output (every union member, cheap)
// and the bodies actually served over HTTP for 404/451/410 (what a visitor
// really receives), because the second is the claim and the first is the sweep.

import { describe, expect, it } from "vitest";

import { DRAFT_GRACE_DAYS, DRAFT_TTL_DAYS } from "@kept/shared";
import { MASCOT_REST_T, mascotSvg } from "@kept/shared/mascot";

import { renderSystemPage, type SystemPage } from "../src/system-pages";
import {
  APEX_ORIGIN,
  describeResponse,
  dispatchText,
  requestFor,
  seedSite,
  SYSTEM_PAGE_TITLES,
} from "./fixtures";

/**
 * Every member of the `SystemPage` union.
 *
 * `satisfies` keeps this list assignable to the union; the two `AssertNever`
 * lines below keep it EQUAL to the union. Adding a fourth template — resurrecting
 * the retired funding-degradation page, say — makes `Exclude<SystemPage, …>`
 * non-`never` and FAILS `pnpm typecheck` on this file, which is the only place a
 * type-level union can be pinned from. The runtime tests then sweep whatever is
 * listed here, so a new member cannot arrive without also being scanned for
 * external requests and given a status.
 */
const ALL_SYSTEM_PAGES = ["notFound", "suspended", "expired"] as const satisfies readonly SystemPage[];

/** Compile-time `T extends never` assertion. Instantiating it with anything else is an error. */
type AssertNever<T extends never> = T;

/** A fourth `SystemPage` member breaks the typecheck here. */
type _NoUnlistedSystemPage = AssertNever<Exclude<SystemPage, (typeof ALL_SYSTEM_PAGES)[number]>>;
/** And a member listed here that is not in the union breaks it too. */
type _NoStaleListedPage = AssertNever<Exclude<(typeof ALL_SYSTEM_PAGES)[number], SystemPage>>;

/** Status per page. Reviewed and confirmed 2026-08-03; see `SystemPageSpec.status`. */
const EXPECTED_STATUS: Record<SystemPage, number> = {
  notFound: 404,
  suspended: 451,
  expired: 410,
};

/** A deliberately non-production apex, so a hardcoded `kept.host` cannot pass. */
const TEST_APEX = "https://apex.test.example";

/**
 * Absolute URLs in a rendered page, excluding XML namespace URIs.
 *
 * `http://www.w3.org/…` in an `xmlns` is an identifier, never a fetch — no
 * browser dereferences it — so counting it as an external request would be a
 * false positive that pressures a future author into deleting a legitimate
 * attribute. Nothing else is excused.
 */
function absoluteUrls(html: string): string[] {
  return [...html.matchAll(/https?:\/\/[^\s"'()<>]+/g)]
    .map((match) => match[0])
    .filter((url) => !url.startsWith("http://www.w3.org/"));
}

/** Every `url(...)` argument in the inline CSS, unquoted. */
function cssUrls(html: string): string[] {
  return [...html.matchAll(/url\(\s*['"]?([^)'"]*)/g)].map((match) => (match[1] ?? "").trim());
}

/**
 * The whole self-containment contract, applied to one rendered page.
 *
 * Shared by the direct-render sweep and the served-bytes check so the two can
 * never drift on what "self-contained" means.
 */
function expectSelfContained(label: string, html: string, apexOrigin: string): void {
  // `<link>` is the single biggest offender in imported design markup: the
  // Google Fonts tag the source comment says was stripped is a `<link>`, and
  // re-pasting from the design file is exactly how it would come back.
  expect(
    /<link\b/i.test(html),
    `${label} contains a <link> element. Every <link> — stylesheet, preload, icon, webfont — is a network request the error path must not depend on.`,
  ).toBe(false);

  // Covers <script src>, <img>, <iframe>, <embed>, <video>, <audio> in one
  // assertion: they all need `src`. There is no legitimate `src=` on these pages.
  expect(
    /\bsrc\s*=/i.test(html),
    `${label} contains a src= attribute. A system page loads no remote script, image, frame or media — every graphic on these pages, the mascot included, is inline SVG.`,
  ).toBe(false);
  expect(
    /\bsrcset\s*=/i.test(html),
    `${label} contains a srcset= attribute, which is a remote image by another name.`,
  ).toBe(false);

  // <script> at all, not just remote: the strict `kept-own` CSP has NO
  // `script-src` grant, so an inline script here would be silently dead code.
  expect(
    /<script\b/i.test(html),
    `${label} contains a <script> element. The kept-own CSP grants no script-src at all, so it could never run — and a remote one would be an external request.`,
  ).toBe(false);

  expect(
    /@import\b/i.test(html),
    `${label} contains an @import in its CSS, which fetches a stylesheet at parse time.`,
  ).toBe(false);

  // `url(#id)` is a same-document fragment reference — an SVG paint server,
  // mask, clip path or filter defined in the very same bytes. It is resolved
  // against the document, never dereferenced over the network, so it cannot be
  // an external request. The mascot renders exactly one: its eyes are clipped
  // by a `<mask>` declared in the same `<svg>`, so every page here carries a
  // `url(#kept-mascot)`. This arm is what lets that ship — without it the rule
  // would pressure the next author into flattening legitimate artwork to dodge
  // the linter. Same call the `absoluteUrls` helper makes for `xmlns`.
  // Everything that CAN reach the network is still forbidden.
  for (const url of cssUrls(html)) {
    expect(
      url.startsWith("data:") || url.startsWith("#"),
      `${label} has a CSS url(${url}). Only inline data: URIs and same-document #fragment references are permitted — a remote background, mask or @font-face src is a network request.`,
    ).toBe(true);
  }

  // The catch-all. Anything absolute that survives must be a navigation target
  // on kept's own control plane, which costs the visitor nothing until they
  // click it.
  for (const url of absoluteUrls(html)) {
    expect(
      url.startsWith(apexOrigin),
      `${label} references ${url}, which is neither the control-plane origin (${apexOrigin}) nor an inline data: URI. A system page must render with zero network access.`,
    ).toBe(true);
  }
}

describe("system pages are self-contained at the edge (task 004)", () => {
  for (const page of ALL_SYSTEM_PAGES) {
    it(`renders ${page} with zero external requests`, () => {
      const { body } = renderSystemPage(page, { apexOrigin: TEST_APEX });
      expectSelfContained(`renderSystemPage("${page}")`, body, TEST_APEX);
    });
  }

  it("proves the scan is not vacuous — it rejects a page carrying a CDN link", () => {
    // Without this, every assertion above would still pass if `absoluteUrls`
    // silently stopped matching or `expectSelfContained` stopped asserting.
    const { body } = renderSystemPage("notFound", { apexOrigin: TEST_APEX });
    const poisoned = body.replace(
      "</head>",
      `<link rel="stylesheet" href="https://cdn.example.com/reset.css" /></head>`,
    );

    expect(() => expectSelfContained("poisoned fixture", poisoned, TEST_APEX)).toThrow();
  });

  it("serves 404/451/410 bodies that are self-contained on the wire", async () => {
    await seedSite("sp-suspended", { status: "under_review" });
    await seedSite("sp-expired", { status: "expired" });

    const served: { page: SystemPage; slug: string }[] = [
      { page: "notFound", slug: "sp-never-published" },
      { page: "suspended", slug: "sp-suspended" },
      { page: "expired", slug: "sp-expired" },
    ];

    for (const { page, slug } of served) {
      const { response, text } = await dispatchText(requestFor(slug));

      expect(
        response.status,
        `fixture sanity: ${slug} must render the ${page} page. Got ${describeResponse(response, text)}`,
      ).toBe(EXPECTED_STATUS[page]);
      // The SERVED apex is `KEPT_APEX_ORIGIN` from `[env.dev.vars]`, not the
      // module's production default — see the apex-origin group below.
      expectSelfContained(`the served ${page} page (${response.status})`, text, APEX_ORIGIN);
    }
  });
});

describe("system page apex links come from the caller, not from a constant (task 004)", () => {
  for (const page of ALL_SYSTEM_PAGES) {
    it(`points every ${page} link at the apexOrigin it was given`, () => {
      const { body } = renderSystemPage(page, { apexOrigin: TEST_APEX });
      const hrefs = [...body.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? "");

      expect(hrefs.length, `${page} must render at least one link back to the control plane`).toBeGreaterThan(0);
      for (const href of hrefs) {
        expect(
          href.startsWith(TEST_APEX),
          `${page} links to ${href} instead of the passed apexOrigin ${TEST_APEX}. A link target baked into the module sends dev visitors to production.`,
        ).toBe(true);
      }
      expect(
        body.includes("https://kept.host"),
        `${page} still contains the production default apex even though a different origin was passed`,
      ).toBe(false);
    });
  }

  it("serves links to KEPT_APEX_ORIGIN, so dev pages point at dev", async () => {
    // `index.ts` passes `c.env.KEPT_APEX_ORIGIN` down. The dev var is
    // `https://kept-dev.xyz`, so a page that fell back to the module's
    // `DEFAULT_APEX_ORIGIN` would send a dev visitor to production — which is
    // the same class of bug as a hardcoded link and just as invisible.
    const { response, text } = await dispatchText(requestFor("sp-apex-check"));

    expect(response.status, `expected the branded 404, got ${describeResponse(response, text)}`).toBe(404);
    expect(text, "the served page must link to this environment's apex origin").toContain(`href="${APEX_ORIGIN}/"`);
  });
});

describe("system page document shell (task 004)", () => {
  for (const page of ALL_SYSTEM_PAGES) {
    it(`gives ${page} a title, a language and a viewport`, () => {
      const { body } = renderSystemPage(page, { apexOrigin: TEST_APEX });

      // `lang` is an accessibility requirement, not a nicety: without it a
      // screen reader guesses the pronunciation rules for the whole page.
      expect(body, `${page} must declare its language on <html>`).toContain('<html lang="en">');
      expect(body, `${page} must declare its charset before any text`).toMatch(/<meta charset="utf-8"/i);
      // Without a viewport meta these pages render at desktop width on a phone
      // — and a 404 is disproportionately arrived at from a shared link.
      expect(body, `${page} must set a mobile viewport`).toMatch(
        /<meta name="viewport" content="width=device-width/i,
      );
      // `noindex`: a suspended or expired page must not accumulate search
      // presence, and an indexed 404 is worse than no result.
      expect(body, `${page} must not be indexable`).toMatch(/<meta name="robots" content="noindex"/i);

      const title = /<title>([^<]*)<\/title>/.exec(body)?.[1] ?? "";
      expect(title.trim().length, `${page} must have a non-empty <title> — it is what a browser tab shows`).toBeGreaterThan(0);
      expect(title, `${page}'s title must carry the "${SYSTEM_PAGE_TITLES[page]}" copy`).toContain(
        SYSTEM_PAGE_TITLES[page],
      );
      expect(title, `${page}'s title must be suffixed with the brand`).toContain("kept");
    });
  }

  it("gives each page its own reviewed status code, and no two share one", () => {
    const statuses = ALL_SYSTEM_PAGES.map((page) => renderSystemPage(page).status);

    for (const page of ALL_SYSTEM_PAGES) {
      expect(
        renderSystemPage(page).status,
        `${page} must answer ${EXPECTED_STATUS[page]} — the codes were reviewed and confirmed on 2026-08-03 and are not to be re-litigated`,
      ).toBe(EXPECTED_STATUS[page]);
    }
    expect(
      new Set(statuses).size,
      `the three states must be machine-distinguishable, got ${JSON.stringify(statuses)}`,
    ).toBe(ALL_SYSTEM_PAGES.length);
  });

  it("keeps the fixtures' title map aligned with the union", () => {
    expect(
      Object.keys(SYSTEM_PAGE_TITLES).sort(),
      "a system page without an entry in SYSTEM_PAGE_TITLES is one the rest of the suite cannot assert on",
    ).toEqual([...ALL_SYSTEM_PAGES].sort());
  });
});

describe("the expired page states the draft windows from @kept/shared (task 004)", () => {
  it("interpolates DRAFT_TTL_DAYS and DRAFT_GRACE_DAYS", () => {
    const { body } = renderSystemPage("expired", { apexOrigin: TEST_APEX });

    expect(body, `the 7-day draft clock must come from DRAFT_TTL_DAYS (${DRAFT_TTL_DAYS})`).toContain(
      `${DRAFT_TTL_DAYS} days`,
    );
    expect(body, `the grace window must come from DRAFT_GRACE_DAYS (${DRAFT_GRACE_DAYS})`).toContain(
      `${DRAFT_GRACE_DAYS} days`,
    );
  });

  it("states no day-count that is not one of those two constants", () => {
    // The drift guard. A literal that happens to equal today's constant reads
    // identically in the output, so no runtime test can tell them apart — but
    // the failure that actually happens is the constant moving and one of the
    // three copy sites staying behind, and this catches that on the next run.
    // The expired page mentions the grace window twice; both must move together.
    const { body } = renderSystemPage("expired", { apexOrigin: TEST_APEX });
    const allowed = new Set([String(DRAFT_TTL_DAYS), String(DRAFT_GRACE_DAYS)]);
    const stated = [...body.matchAll(/(\d+)\s+days/g)].map((match) => match[1] ?? "");

    expect(stated.length, "the expired page must state the draft windows at all").toBeGreaterThan(0);
    for (const days of stated) {
      expect(
        allowed.has(days),
        `the expired page states "${days} days", which is neither DRAFT_TTL_DAYS (${DRAFT_TTL_DAYS}) nor DRAFT_GRACE_DAYS (${DRAFT_GRACE_DAYS}) — a copy site was left behind when a constant changed`,
      ).toBe(true);
    }
  });

  it("does not state a day-count on the pages that have no clock", () => {
    for (const page of ["notFound", "suspended"] as const) {
      const { body } = renderSystemPage(page, { apexOrigin: TEST_APEX });
      expect(
        [...body.matchAll(/(\d+)\s+days/g)].map((match) => match[0]),
        `${page} has no draft clock, so a day-count there is copy that drifted in from another template`,
      ).toEqual([]);
    }
  });
});

/* ───────────────────────────────────────────────────────────────────────────
   The mascot (task 005).

   `mascot(mood)` used to paint a 20,719-byte base64 WebP through a `--mascot`
   custom property. It now emits an inline `<svg>` from `@kept/shared/mascot`,
   frozen at `MASCOT_REST_T`. Three things need pinning, and none of them is
   cosmetic:

     · the emitted `d`, because the generator is shared with apps/web and a
       silent change there would redraw the character on the serve path;
     · the three moods, because a filter and a pip — never a second asset — are
       what keep one character across 404, 451 and 410;
     · the page size, because the whole point of the swap was the ~20 KB.
   ─────────────────────────────────────────────────────────────────────────── */

/** The mask id `system-pages.ts` passes. A literal there; `useId()` in apps/web. */
const MASCOT_MASK_ID = "kept-mascot";

/**
 * The body outline at the Worker's 32 samples, pinned byte for byte.
 *
 * MEASURED, not chosen: 32 and 64 were emitted and overlaid at 600 px — 3.5x
 * the 170 px these pages draw at — and the two curves are coincident there;
 * 16 separates visibly at the corners. So 32 is the smallest count that is
 * indistinguishable at the display size, and it is 2,376 bytes cheaper.
 *
 * If this fails, the generator moved. Re-render, LOOK at it, then update.
 */
const MASCOT_D_EDGE =
  "M82.58 0.22C82.58 5.68 82.65 10.96 82.54 16.61C82.43 22.25 82.55 28.07 81.92 34.09C81.29 40.11 80.86 46.87 78.75 52.74C76.64 58.62 73.61 64.99 69.26 69.34C64.91 73.68 58.54 76.72 52.67 78.83C46.79 80.94 40.04 81.37 34.02 82C27.99 82.63 22.18 82.51 16.53 82.62C10.88 82.73 5.6 82.66 0.14 82.66C-5.32 82.66 -10.61 82.73 -16.25 82.62C-21.9 82.51 -27.71 82.63 -33.74 82C-39.76 81.37 -46.51 80.94 -52.39 78.83C-58.26 76.72 -64.63 73.68 -68.98 69.34C-73.33 64.99 -76.36 58.62 -78.47 52.74C-80.58 46.87 -81.01 40.11 -81.64 34.09C-82.28 28.07 -82.15 22.25 -82.26 16.61C-82.37 10.96 -82.3 5.68 -82.3 0.22C-82.3 -5.25 -82.37 -10.53 -82.26 -16.17C-82.15 -21.82 -82.28 -27.64 -81.64 -33.66C-81.01 -39.68 -80.58 -46.44 -78.47 -52.31C-76.36 -58.18 -73.33 -64.56 -68.98 -68.9C-64.63 -73.25 -58.26 -76.28 -52.39 -78.4C-46.51 -80.51 -39.76 -80.94 -33.74 -81.57C-27.71 -82.2 -21.9 -82.08 -16.25 -82.19C-10.61 -82.3 -5.32 -82.23 0.14 -82.23C5.6 -82.23 10.88 -82.3 16.53 -82.19C22.18 -82.08 27.99 -82.2 34.02 -81.57C40.04 -80.94 46.79 -80.51 52.67 -78.4C58.54 -76.28 64.91 -73.25 69.26 -68.9C73.61 -64.56 76.64 -58.18 78.75 -52.31C80.86 -46.44 81.29 -39.68 81.92 -33.66C82.55 -27.64 82.43 -21.82 82.54 -16.17C82.65 -10.53 82.58 -5.25 82.58 0.22Z";

/**
 * The same instant at the generator's default 64 samples — the outline apps/web
 * animates and freezes on under `prefers-reduced-motion`.
 *
 * Pinned HERE, in the Worker's suite, because the counts differ and both must
 * fail CI when the shared generator moves. This is the only assertion in the
 * repo that would catch a change to the 64-point curve arriving through
 * `packages/shared` while the Worker's 32-point curve happened to survive it.
 */
const MASCOT_D_WEB =
  "M82.58 0.22C82.58 2.92 82.58 5.6 82.58 8.34C82.57 11.07 82.57 13.8 82.54 16.61C82.51 19.41 82.48 22.25 82.38 25.16C82.28 28.08 82.18 31.06 81.92 34.09C81.67 37.13 81.4 40.26 80.87 43.37C80.34 46.47 79.73 49.69 78.75 52.74C77.78 55.79 76.6 58.9 75.02 61.67C73.43 64.43 71.5 67.1 69.26 69.34C67.02 71.57 64.35 73.51 61.59 75.09C58.82 76.67 55.72 77.85 52.67 78.83C49.62 79.8 46.4 80.41 43.29 80.94C40.18 81.47 37.05 81.75 34.02 82C30.98 82.25 28 82.35 25.09 82.46C22.17 82.56 19.33 82.58 16.53 82.62C13.73 82.65 10.99 82.65 8.26 82.65C5.53 82.66 2.85 82.66 0.14 82.66C-2.57 82.66 -5.25 82.66 -7.98 82.65C-10.71 82.65 -13.45 82.65 -16.25 82.62C-19.06 82.58 -21.89 82.56 -24.81 82.46C-27.72 82.35 -30.7 82.25 -33.74 82C-36.77 81.75 -39.9 81.47 -43.01 80.94C-46.12 80.41 -49.34 79.8 -52.39 78.83C-55.44 77.85 -58.54 76.67 -61.31 75.09C-64.08 73.51 -66.74 71.57 -68.98 69.34C-71.22 67.1 -73.16 64.43 -74.74 61.67C-76.32 58.9 -77.5 55.79 -78.47 52.74C-79.45 49.69 -80.06 46.47 -80.59 43.37C-81.12 40.26 -81.39 37.13 -81.64 34.09C-81.9 31.06 -82 28.08 -82.1 25.16C-82.21 22.25 -82.23 19.41 -82.26 16.61C-82.3 13.8 -82.29 11.07 -82.3 8.34C-82.31 5.6 -82.3 2.92 -82.3 0.22C-82.3 -2.49 -82.31 -5.17 -82.3 -7.9C-82.29 -10.64 -82.3 -13.37 -82.26 -16.17C-82.23 -18.98 -82.21 -21.82 -82.1 -24.73C-82 -27.65 -81.9 -30.63 -81.64 -33.66C-81.39 -36.69 -81.12 -39.83 -80.59 -42.93C-80.06 -46.04 -79.45 -49.26 -78.47 -52.31C-77.5 -55.36 -76.32 -58.47 -74.74 -61.23C-73.16 -64 -71.22 -66.67 -68.98 -68.9C-66.74 -71.14 -64.08 -73.08 -61.31 -74.66C-58.54 -76.24 -55.44 -77.42 -52.39 -78.4C-49.34 -79.37 -46.12 -79.98 -43.01 -80.51C-39.9 -81.04 -36.77 -81.32 -33.74 -81.57C-30.7 -81.82 -27.72 -81.92 -24.81 -82.03C-21.89 -82.13 -19.06 -82.15 -16.25 -82.19C-13.45 -82.22 -10.71 -82.22 -7.98 -82.22C-5.25 -82.23 -2.57 -82.23 0.14 -82.23C2.85 -82.23 5.53 -82.23 8.26 -82.22C10.99 -82.22 13.73 -82.22 16.53 -82.19C19.33 -82.15 22.17 -82.13 25.09 -82.03C28 -81.92 30.98 -81.82 34.02 -81.57C37.05 -81.32 40.18 -81.04 43.29 -80.51C46.4 -79.98 49.62 -79.37 52.67 -78.4C55.72 -77.42 58.82 -76.24 61.59 -74.66C64.35 -73.08 67.02 -71.14 69.26 -68.9C71.5 -66.67 73.43 -64 75.02 -61.23C76.6 -58.47 77.78 -55.36 78.75 -52.31C79.73 -49.26 80.34 -46.04 80.87 -42.93C81.4 -39.83 81.67 -36.69 81.92 -33.66C82.18 -30.63 82.28 -27.65 82.38 -24.73C82.48 -21.82 82.51 -18.98 82.54 -16.17C82.57 -13.37 82.57 -10.64 82.58 -7.9C82.58 -5.17 82.58 -2.49 82.58 0.22Z";

/**
 * `renderSystemPage(...).body.length` per page immediately BEFORE task 005, at
 * `TEST_APEX`, with the base64 WebP still bound to `--mascot`.
 *
 * Recorded rather than derived: the claim is a real page getting smaller, not
 * arithmetic on a base64 string.
 */
const BYTES_BEFORE_INLINE_MASCOT: Record<SystemPage, number> = {
  notFound: 27753,
  suspended: 28275,
  expired: 28207,
};

/** The data: URI the inline SVG replaced, in characters. All of it is gone. */
const RETIRED_DATA_URI_CHARS = 20_719;

/**
 * The floor the NET per-page saving must clear.
 *
 * Not `RETIRED_DATA_URI_CHARS`: the replacement is not free. All 20,719
 * characters of the data URI came off and 3,185 characters of inline `<svg>`
 * went back on; the mascot's hover keyframe, the `--shadow-lg` token and their
 * comments then cost a further 1,107. The net is **15,920 per page, measured**
 * — 11,833 / 12,355 / 12,287 characters rendered against the 27,753 / 28,275 /
 * 28,207 the raster cost, about 57% of the document. (17,027 before the hover
 * and the shadow, and 15,969 while the hover was 6px over 5s; both figures are
 * superseded by a re-measurement, not loosened away from.)
 *
 * A criterion of "≥ 20,719 net" is unsatisfiable by any drawing at all; this is
 * the strictest floor an actual replacement can meet, and it still fails loudly
 * if the raster returns or the outline balloons.
 */
const MIN_NET_SAVING_CHARS = 15_900;

/** The lock pip, byte-identical to `system-pages.ts`. 451 and nothing else. */
const PIP_MARKER = 'stroke="var(--warning)"';

describe("the mascot is the generated frozen frame (task 005)", () => {
  for (const page of ALL_SYSTEM_PAGES) {
    it(`draws ${page}'s mascot from the pinned 32-sample outline`, () => {
      const { body } = renderSystemPage(page, { apexOrigin: TEST_APEX });

      // Twice: once filled, once into the mask the eyes clip against.
      expect(
        body,
        `${page}'s mascot body path is not the pinned outline. The shared generator moved — re-render it, look at it at 170px, and update MASCOT_D_EDGE deliberately.`,
      ).toContain(`<path d="${MASCOT_D_EDGE}" fill="currentColor"/>`);
      expect(body, `${page}'s mascot must clip its eyes against a same-document mask`).toContain(
        `<mask id="${MASCOT_MASK_ID}"`,
      );
      expect(body, `${page}'s eyes must be masked by that id`).toContain(`mask="url(#${MASCOT_MASK_ID})"`);
    });
  }

  it("pins the 64-sample outline apps/web renders from the same generator", () => {
    expect(
      mascotSvg(MASCOT_REST_T, { maskId: MASCOT_MASK_ID, samples: 64 }),
      "the generator's default 64-point outline changed. apps/web draws this one at up to 600px, where the difference IS visible — re-render and look before updating the pin.",
    ).toContain(`<path d="${MASCOT_D_WEB}" fill="currentColor"/>`);
  });

  it("paints with tokens only — currentColor body, var(--bg) eyes, no hex", () => {
    const { body } = renderSystemPage("notFound", { apexOrigin: TEST_APEX });
    const svg = /<div class="mascot[^"]*" aria-hidden="true">(<svg[\s\S]*?<\/svg>)/.exec(body)?.[1] ?? "";

    expect(svg.length, "the notFound page must render an inline mascot <svg>").toBeGreaterThan(0);
    expect(svg, "the mascot body must inherit its colour so the page's theme owns it").toContain(
      'fill="currentColor"',
    );
    expect(svg, "the eyes must punch through to the page background token").toContain('fill="var(--bg)"');
    expect(
      /#[0-9a-f]{3,8}\b/i.test(svg),
      `the mascot must not carry a hex colour — tokens are law. Found: ${/#[0-9a-f]{3,8}\b/i.exec(svg)?.[0]}`,
    ).toBe(false);
  });

  it("gives each page its mood: 404 plain, 451 the pip, 410 the filter", () => {
    const classOf = (page: SystemPage): string =>
      /<div class="(mascot[^"]*)" aria-hidden="true">/.exec(
        renderSystemPage(page, { apexOrigin: TEST_APEX }).body,
      )?.[1] ?? "";

    expect(classOf("notFound"), "404 is the character as generated — no treatment").toBe("mascot");
    expect(classOf("suspended"), "451 keeps the amber pip").toBe("mascot m-pip");
    expect(classOf("expired"), "410 is drained by the CSS filter").toBe("mascot m-dim");
  });

  it("shows the pip on 451 only, and dims 410 with a filter rather than a second asset", () => {
    const bodies = Object.fromEntries(
      ALL_SYSTEM_PAGES.map((page) => [page, renderSystemPage(page, { apexOrigin: TEST_APEX }).body]),
    ) as Record<SystemPage, string>;

    expect(bodies.suspended, "451 must render the amber lock pip").toContain(PIP_MARKER);
    expect(bodies.notFound.includes(PIP_MARKER), "404 has nothing to signal — no pip").toBe(false);
    expect(bodies.expired.includes(PIP_MARKER), "410 is a lapsed draft, not a moderated page — no pip").toBe(
      false,
    );

    // One artwork, three readings. A second outline on any page means someone
    // drew the dim or locked character separately, which is what drift is.
    for (const page of ALL_SYSTEM_PAGES) {
      const outlines = [...bodies[page].matchAll(new RegExp(`d="${MASCOT_D_EDGE}"`, "g"))].length;
      expect(
        outlines,
        `${page} draws the mascot outline ${outlines} times; it must be exactly twice — the filled body and the mask it clips the eyes against.`,
      ).toBe(2);
    }
  });

  it("carries aria-hidden and no role, because it is decoration", () => {
    for (const page of ALL_SYSTEM_PAGES) {
      const { body } = renderSystemPage(page, { apexOrigin: TEST_APEX });

      expect(body, `${page}'s mascot must be hidden from the accessibility tree`).toMatch(
        /<div class="mascot[^"]*" aria-hidden="true">/,
      );
      // `role="img"` on an `aria-hidden` element is contradictory: the role names
      // a graphic the same attribute has already removed from the tree.
      expect(
        /role\s*=/i.test(body),
        `${page} declares an ARIA role. The mascot is decoration and states nothing the copy does not — aria-hidden alone is the correct pairing.`,
      ).toBe(false);
    }
  });

  it("leaves no data: URI, no --mascot property and no aspect-ratio guard behind", () => {
    for (const page of ALL_SYSTEM_PAGES) {
      const { body } = renderSystemPage(page, { apexOrigin: TEST_APEX });

      expect(
        /data:/i.test(body),
        `${page} still carries a data: URI. The mascot is inline SVG now; a data: URI here means the raster came back.`,
      ).toBe(false);
      expect(body.includes("--mascot"), `${page} still defines the retired --mascot custom property`).toBe(
        false,
      );
      expect(
        body.includes("aspect-ratio"),
        `${page} still pins an aspect ratio in CSS. The ratio is intrinsic to the generator's viewBox.`,
      ).toBe(false);
    }
  });

  it(`is at least ${MIN_NET_SAVING_CHARS} characters smaller on every page`, () => {
    for (const page of ALL_SYSTEM_PAGES) {
      const before = BYTES_BEFORE_INLINE_MASCOT[page];
      const after = renderSystemPage(page, { apexOrigin: TEST_APEX }).body.length;

      expect(
        before - after,
        `${page} is now ${after} characters against ${before} before — a net saving of ${before - after}. All ${RETIRED_DATA_URI_CHARS} characters of the base64 WebP must come off and only the inline outline go back on; a smaller saving means a raster, or a much heavier frame, has crept in.`,
      ).toBeGreaterThanOrEqual(MIN_NET_SAVING_CHARS);
    }
  });

  it("hovers and sits on --shadow-lg, in both themes, with the motion reducible", () => {
    // The two CSS-only halves of the interactive mascot. `apps/web` gets pointer
    // tracking; the Worker cannot (no script), so these are the parts that keep
    // the character looking like one character in both places, and each has a
    // way of silently going missing.
    const { body } = renderSystemPage("notFound", { apexOrigin: TEST_APEX });

    // Token, not a raw shadow: a hex or rgba() on `.mascot` itself would not
    // flip with the theme, and tokens are law.
    expect(body, "the mascot must sit on the shared elevation token").toContain(
      "box-shadow:var(--shadow-lg)",
    );
    expect(body, "--shadow-lg must be defined for light").toContain("--shadow-lg:0 12px 40px rgba(40,30,20,0.12)");
    expect(body, "--shadow-lg must be remapped for dark, or the shadow vanishes on a dark page").toContain(
      "--shadow-lg:0 12px 40px rgba(0,0,0,0.5)",
    );

    // A CSS transform on the box. NOT baked into the path or the eye centres:
    // the generator's viewBox is tight to the silhouette, so animated geometry
    // would clip the character's outline against it.
    expect(body, "the mascot must run the hover keyframe").toMatch(
      /animation:hover 3s ease-in-out infinite alternate/,
    );
    // The same period, amplitude and shape as apps/web's keptMascotHover, and a
    // PERCENTAGE amplitude so the bob is proportional to whichever size draws it
    // — 96px there, 170px here. A px value would look like a different character.
    expect(body, "the hover must translate the element, not redraw it").toContain(
      "@keyframes hover{from{transform:translateY(-3%)}to{transform:translateY(3%)}}",
    );

    // Design system §6: every animation has a static equivalent. The wildcard in
    // the reduce block is what supplies it — dropping it would leave the mascot
    // drifting for a visitor who asked for stillness.
    const reduceBlock = /@media \(prefers-reduced-motion:reduce\)\{([^}]*\})/.exec(body)?.[1] ?? "";
    expect(
      reduceBlock,
      "the reduced-motion block must switch every animation off, the mascot's hover included",
    ).toContain("animation:none!important");
  });

  it("serves the frozen frame on the wire, not just from renderSystemPage", async () => {
    await seedSite("mascot-suspended", { status: "under_review" });
    await seedSite("mascot-expired", { status: "expired" });

    const served: { page: SystemPage; slug: string; cls: string }[] = [
      { page: "notFound", slug: "mascot-never-published", cls: "mascot" },
      { page: "suspended", slug: "mascot-suspended", cls: "mascot m-pip" },
      { page: "expired", slug: "mascot-expired", cls: "mascot m-dim" },
    ];

    for (const { page, slug, cls } of served) {
      const { response, text } = await dispatchText(requestFor(slug));

      expect(
        response.status,
        `fixture sanity: ${slug} must render the ${page} page. Got ${describeResponse(response, text)}`,
      ).toBe(EXPECTED_STATUS[page]);
      expect(text, `the served ${page} page must carry the pinned outline`).toContain(MASCOT_D_EDGE);
      expect(text, `the served ${page} page must carry the ${cls} treatment`).toContain(
        `<div class="${cls}" aria-hidden="true">`,
      );
      expect(
        text.length,
        `the served ${page} page is ${text.length} characters; the inline mascot must keep it at least ${MIN_NET_SAVING_CHARS} under the ${BYTES_BEFORE_INLINE_MASCOT[page]} the raster cost. This is the wire, not renderSystemPage — it is the number a visitor actually pays.`,
      ).toBeLessThanOrEqual(BYTES_BEFORE_INLINE_MASCOT[page] - MIN_NET_SAVING_CHARS);
    }
  });
});
