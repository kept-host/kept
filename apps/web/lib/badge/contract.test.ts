/**
 * E10 task 001 — the badge contract in `@kept/shared` (./badge, ./kv-manifest).
 *
 * Lives in `apps/web` because `packages/shared` has no test runner (precedent:
 * `lib/agents/contract.test.ts`). Pure: no store is touched. Real code, no mocks.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  BADGE_MAX_BYTES,
  BADGE_STYLES,
  BADGE_TOKENS,
  PROVENANCE_LIMITS,
  SLUG_MAX_LENGTH,
  badgeDataSchema,
  isRedirectManifest,
  kvEntrySchema,
  kvManifestSchema,
  remixAllowed,
  renderBadge,
  type BadgeData,
} from "@kept/shared";

const APEX = "https://kept.host";
const SLUG = "recipe-notes";
const CTX = { apexOrigin: APEX, pageOrigin: `https://${SLUG}.kept.host`, slug: SLUG };
const XSS = `"><script>alert(1)</script>`;

const bytes = (html: string) => new TextEncoder().encode(html).length;

/** The shadow root's content, without the light-DOM fallback line. */
function shadow(html: string): string {
  return html.slice(html.indexOf("<template"), html.indexOf("</template>"));
}

test("BadgeData: the PRD D3 shape, and nothing else", () => {
  assert.deepEqual(BADGE_STYLES, ["standard", "minimal"]);
  assert.equal(BADGE_MAX_BYTES, 4096);
  const full: BadgeData = {
    variant: "kept",
    style: "minimal",
    model: "claude-opus-4-7",
    readme: true,
    remix: true,
    refCode: "arun",
    handle: "arun",
  };
  assert.deepEqual(badgeDataSchema.parse(full), full);
  assert.deepEqual(badgeDataSchema.parse({ variant: "draft", style: "standard" }), {
    variant: "draft",
    style: "standard",
  });
  assert.equal(badgeDataSchema.safeParse({ ...full, readme: false }).success, false, "readme is `true` or absent");
  assert.equal(badgeDataSchema.safeParse({ ...full, variant: "expired" }).success, false);
  assert.equal(
    badgeDataSchema.safeParse({ ...full, model: "m".repeat(PROVENANCE_LIMITS.model + 1) }).success,
    false,
  );
});

test("draft: 'Draft · kept.host' to the explainer and a report link — no claim URL, token or countdown (D4)", () => {
  const { html, badgeHash } = renderBadge({ variant: "draft", style: "standard" }, CTX);
  console.log(`[badge] draft ${bytes(html)} bytes, hash ${badgeHash}`);
  assert.match(html, /^<kept-badge><template shadowrootmode="open"><style>/);
  assert.match(html, /<\/kept-badge>$/);
  assert.ok(html.includes(`href="${APEX}/drafts"`));
  assert.ok(html.includes("Draft · kept.host"));
  assert.ok(html.includes(`href="${APEX}/report?url=${encodeURIComponent(`${CTX.pageOrigin}/`)}"`));
  for (const banned of ["/keep/", "/p/", "claim", "kpt_", "token", "days left", "?ref="]) {
    assert.ok(!html.includes(banned), `draft badge contains ${banned}`);
  }
  // No token-shaped run: nothing 20+ characters of base64url outside the styles.
  assert.doesNotMatch(html.replace(/<style>.*?<\/style>/, ""), /[A-Za-z0-9_-]{20,}/);
  assert.match(badgeHash, /^[0-9a-f]{8}$/);
});

test("kept standard: mark with ref, by @handle, Made with, README, Remix, Report (PRD §5.1)", () => {
  const { html } = renderBadge(
    { variant: "kept", style: "standard", model: "claude-opus-4-7", readme: true, remix: true, refCode: "arun", handle: "arun" },
    CTX,
  );
  const inner = shadow(html);
  const order = [
    `href="${APEX}/?ref=arun"`,
    "by @arun",
    "Made with claude-opus-4-7",
    `href="${CTX.pageOrigin}/_kept/readme"`,
    `href="${APEX}/remix/${SLUG}"`,
    `href="${APEX}/report?url=`,
  ].map((needle) => {
    const at = inner.indexOf(needle);
    assert.ok(at >= 0, `missing ${needle}`);
    return at;
  });
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in the PRD's order");
  assert.ok(!inner.includes("<details>"), "standard is always expanded");
  assert.ok(!html.includes("<slot"), "no slot: the light-DOM fallback never renders beside the shadow root");
});

test("kept standard without the optional parts shows only the mark and Report", () => {
  const { html } = renderBadge({ variant: "kept", style: "standard" }, CTX);
  const inner = shadow(html);
  assert.ok(inner.includes(`href="${APEX}/"`));
  for (const absent of ["by @", "Made with", "_kept/readme", "/remix/", "?ref="]) {
    assert.ok(!inner.includes(absent), `unexpected ${absent}`);
  }
});

test("kept minimal: a kept mark that expands with <details>; the handle only inside (Q13)", () => {
  const { html } = renderBadge(
    { variant: "kept", style: "minimal", model: "gpt", remix: true, refCode: "arun", handle: "arun" },
    CTX,
  );
  const inner = shadow(html);
  const details = inner.indexOf("<details>");
  const summaryEnd = inner.indexOf("</summary>");
  assert.ok(details >= 0 && summaryEnd > details);
  assert.ok(inner.indexOf("by @arun") > summaryEnd, "the handle is in the expanded part");
  assert.ok(inner.indexOf("Made with gpt") > summaryEnd);
});

test("the shadow styles carry D2's isolation and PRD §5.1's geometry", () => {
  const { html } = renderBadge({ variant: "kept", style: "standard" }, CTX);
  for (const rule of [
    ":host{all:initial;position:fixed;",
    "right:12px;bottom:12px;",
    "z-index:2147483647",
    "max-width:min(360px,90vw)",
    "font:12px/1.5 ui-monospace",
  ]) {
    assert.ok(html.includes(rule), `missing ${rule}`);
  }
  assert.ok(!/<script/i.test(html), "no script, ever (D2)");
});

test("every interpolated string is HTML-escaped (model, handle, refCode, slug)", () => {
  const { html } = renderBadge(
    { variant: "kept", style: "standard", model: XSS, readme: true, remix: true, refCode: XSS, handle: XSS },
    { ...CTX, slug: XSS },
  );
  assert.ok(!html.includes("<script"), "a script tag got through");
  assert.ok(!html.includes(`"><script`), "an attribute was broken out of");
  assert.ok(html.includes("Made with &quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("by @&quot;&gt;&lt;script&gt;"));
  const quotes = renderBadge({ variant: "kept", style: "standard", model: `a'b&c` }, CTX).html;
  assert.ok(quotes.includes("Made with a&#39;b&amp;c"));
});

test("the largest badge, every field at its cap and worst-case escaping, fits BADGE_MAX_BYTES", () => {
  const longSlug = "a".repeat(SLUG_MAX_LENGTH);
  // A base domain longer than either real one, so the bound holds on dev too.
  const ctx = { apexOrigin: "https://kept-longest.example", pageOrigin: `https://${longSlug}.kept-longest.example`, slug: longSlug };
  const sizes = BADGE_STYLES.map((style) => {
    const { html } = renderBadge(
      {
        variant: "kept",
        style,
        model: `"`.repeat(PROVENANCE_LIMITS.model), // 6 bytes each once escaped
        readme: true,
        remix: true,
        refCode: "z".repeat(SLUG_MAX_LENGTH),
        handle: "h".repeat(SLUG_MAX_LENGTH),
      },
      ctx,
    );
    return bytes(html);
  });
  console.log(`[badge] largest standard ${sizes[0]} B, minimal ${sizes[1]} B (cap ${BADGE_MAX_BYTES})`);
  for (const size of sizes) assert.ok(size <= BADGE_MAX_BYTES, `${size} > ${BADGE_MAX_BYTES}`);
});

test("badgeHash is deterministic and changes with the markup (Risk 1's composite ETag)", () => {
  const a = renderBadge({ variant: "kept", style: "standard", model: "x" }, CTX);
  assert.equal(renderBadge({ variant: "kept", style: "standard", model: "x" }, CTX).badgeHash, a.badgeHash);
  assert.notEqual(renderBadge({ variant: "kept", style: "standard", model: "y" }, CTX).badgeHash, a.badgeHash);
  assert.notEqual(renderBadge({ variant: "draft", style: "standard" }, CTX).badgeHash, a.badgeHash);
});

test("BADGE_TOKENS equal the light tokens in globals.css (Q11 drift check)", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../../app/globals.css"), "utf8");
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  for (const [name, value] of Object.entries(BADGE_TOKENS)) {
    const match = new RegExp(`\\s${name}:\\s*([^;]+);`).exec(root);
    assert.ok(match, `${name} is not in globals.css's :root`);
    assert.equal(match[1]!.trim().toLowerCase(), value.toLowerCase(), `${name} drifted`);
  }
});

test("badge colours exist only as BADGE_TOKENS — no other hex in badge.ts", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../../../../packages/shared/src/badge.ts"), "utf8");
  const tokens = source.slice(source.indexOf("export const BADGE_TOKENS"), source.indexOf("} as const;", source.indexOf("export const BADGE_TOKENS")));
  const outside = source.replace(tokens, "").match(/#[0-9a-f]{3,8}\b/gi) ?? [];
  assert.deepEqual(outside, []);
});

test("remixAllowed: the D8 default rule (Q12)", () => {
  assert.equal(remixAllowed({ allowRemix: null, kept: true, model: "claude" }), true);
  assert.equal(remixAllowed({ allowRemix: null, kept: true, model: null }), false);
  assert.equal(remixAllowed({ allowRemix: false, kept: true, model: "claude" }), false);
  assert.equal(remixAllowed({ allowRemix: true, kept: true, model: null }), true);
  assert.equal(remixAllowed({ allowRemix: true, kept: false, model: "claude" }), false, "never a draft");
});

test("the manifest: a page with or without a badge, a redirect, and the union between them (Q1)", () => {
  const legacy = {
    siteId: "s",
    versionId: "v",
    status: "live" as const,
    region: "auto" as const,
    ownerId: null,
    updatedAt: 1,
  };
  assert.deepEqual(kvManifestSchema.parse(legacy), legacy, "a pre-E10 manifest still parses unchanged");
  const withBadge = { ...legacy, badge: { variant: "kept" as const, style: "standard" as const, remix: true as const } };
  assert.deepEqual(kvManifestSchema.parse(withBadge), withBadge);

  const page = kvEntrySchema.parse(withBadge);
  assert.equal(isRedirectManifest(page), false);
  assert.deepEqual(page, withBadge);

  const redirect = kvEntrySchema.parse({ redirectTo: "arun", updatedAt: 2 });
  assert.equal(isRedirectManifest(redirect), true);
  assert.deepEqual(redirect, { redirectTo: "arun", updatedAt: 2 });
  assert.equal(kvManifestSchema.safeParse({ redirectTo: "arun", updatedAt: 2 }).success, false);
  assert.equal(kvEntrySchema.safeParse({ updatedAt: 2 }).success, false);
});
