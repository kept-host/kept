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
    `${label} contains a src= attribute. A system page loads no remote script, image, frame or media — the mascot and the icons are inline SVG.`,
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
  // an external request. The mascot's body gradient is exactly this. Excusing
  // it is the same call the `absoluteUrls` helper makes for `xmlns`: a rule
  // that flagged it would pressure a future author into deleting a legitimate
  // attribute, or into flattening artwork to dodge the linter. Everything that
  // CAN reach the network is still forbidden.
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
