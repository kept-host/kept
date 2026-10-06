import assert from "node:assert/strict";
import { test } from "node:test";

import { ImageResponse } from "next/og";

import { PAGE_TITLE_MAX_LENGTH } from "@kept/shared";

import { OgCard, ogHeadline, ogRenderable } from "./card";
import {
  OG_CARD_HEIGHT,
  OG_CARD_WIDTH,
  OG_TEMPLATE_VERSION,
  ogCardPath,
  ogCardRevision,
} from "./card-url";
import { ogTypefaces } from "./font";
import { OG_PALETTE, type OgTheme } from "./palette";

/**
 * The OG card — E06 task 010 (D10).
 *
 * Three things a render cannot check for you, because each fails in a way an
 * image looks fine with: the cache key (bug 4), what reaches satori (D10's "no
 * runtime fetch"), and whether the template survives the titles edge case 17
 * names. The last is asserted by rendering the real card, with the real
 * vendored faces, through the real `next/og` — nothing is stubbed.
 */

// ── The cache key (bug 4, URL half) ─────────────────────────────────────────

test("bug 4: two updated_at values give two card URLs", () => {
  // Failing-first against the old token (version id + draft/kept letter): a rename
  // or an owner title edit moves neither half, so the URL stayed put and a card
  // cached `immutable` for a year kept the old name. Every such write moves
  // `updated_at` (task 002's `$onUpdate`), and that is now the whole key.
  const before = { id: "abc", updatedAt: new Date("2026-10-04T12:00:00.000Z") };
  const after = { ...before, updatedAt: new Date("2026-10-04T12:00:00.001Z") };
  assert.notEqual(ogCardPath(before), ogCardPath(after));
});

test("the revision token is updated_at in epoch milliseconds, then the template version", () => {
  const updatedAt = new Date("2026-10-04T12:34:56.789Z");
  assert.equal(ogCardRevision({ id: "s", updatedAt }), `${updatedAt.getTime()}-t2`);
});

test("task 016: the template version is in the key, so mascot cards cached for a year are never asked for again", () => {
  // `?v=<ms>` was task 010's key, under which the mascot card sits in caches
  // with `immutable` on it. The gradient card must live at a different URL for
  // the very same row.
  assert.equal(OG_TEMPLATE_VERSION, "t2");
  const updatedAt = new Date("2026-10-04T00:00:00.000Z");
  assert.notEqual(ogCardPath({ id: "abc", updatedAt }), `/api/og/abc?v=${updatedAt.getTime()}`);
});

test("the card path is app-relative and carries the revision", () => {
  const updatedAt = new Date("2026-10-04T00:00:00.000Z");
  assert.equal(
    ogCardPath({ id: "abc", updatedAt }),
    `/api/og/abc?v=${updatedAt.getTime()}-t2`,
  );
});

// ── What reaches satori ─────────────────────────────────────────────────────

test("text the faces can draw passes through, NFC-normalised", async () => {
  const { coverage } = await ogTypefaces();
  assert.equal(ogRenderable("Anna's Reading List — Summer 2026", coverage), "Anna's Reading List — Summer 2026");
  // `e` + U+0301 COMBINING ACUTE becomes the precomposed `é` the faces carry.
  assert.equal(ogRenderable("Café notes", coverage), "Café notes");
  assert.equal(ogRenderable("Привет мир · Tiếng Việt", coverage), "Привет мир · Tiếng Việt");
});

test("emoji are dropped and leave no gap behind", async () => {
  const { coverage } = await ogTypefaces();
  assert.equal(ogRenderable("🌍 Hello  👋🏽 world 🎉", coverage), "Hello world");
});

test("a title with nothing drawable left is null, not an empty headline", async () => {
  const { coverage } = await ogTypefaces();
  assert.equal(ogRenderable("مرحبا بالعالم", coverage), null);
  assert.equal(ogRenderable("שלום עולם", coverage), null);
  assert.equal(ogRenderable("日本語のページ", coverage), null);
  assert.equal(ogRenderable("🎉🎉🎉", coverage), null);
  // Punctuation alone is not something a reader can read.
  assert.equal(ogRenderable("— · —", coverage), null);
});

test("edge case 17: no title, or an undrawable one, falls back to the name", async () => {
  const { coverage } = await ogTypefaces();
  assert.equal(ogHeadline(null, "orbital-ship", coverage), "orbital-ship");
  assert.equal(ogHeadline("مرحبا بالعالم", "arabic-page", coverage), "arabic-page");
  assert.equal(ogHeadline("🎉🎉🎉", "party", coverage), "party");
  assert.equal(ogHeadline("Party 🎉", "party", coverage), "Party");
});

test("a title at the storage cap reaches the layout whole — the block clamps lines", async () => {
  // The layout cuts by line (`lineClamp`), not this function by characters: a
  // character cap tuned for average glyphs is the wrong cap for `W`.
  const { coverage } = await ogTypefaces();
  const title = "W".repeat(PAGE_TITLE_MAX_LENGTH);
  assert.equal(ogHeadline(title, "wide", coverage), title);
});

// ── The template, rendered ──────────────────────────────────────────────────

/** Width and height from a PNG's IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  assert.equal(png.subarray(1, 4).toString("latin1"), "PNG", "not a PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Render the card for real and report every network request made meanwhile.
 *
 * `fetch` is wrapped, not replaced: each call is recorded and then made for
 * real. `next/og` fetches a fallback for any glyph the registered faces lack —
 * the recorder is how a test sees that happen.
 */
async function render(
  headline: string | null,
  host: string | null,
  theme: OgTheme = OG_PALETTE[0]!,
) {
  const { fonts } = await ogTypefaces();
  const requests: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push(input instanceof Request ? input.url : String(input));
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const response = new ImageResponse(OgCard({ headline, host, theme }), {
      width: OG_CARD_WIDTH,
      height: OG_CARD_HEIGHT,
      fonts,
    });
    return { png: Buffer.from(await response.arrayBuffer()), requests };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const TEMPLATE_CASES: ReadonlyArray<[label: string, title: string | null, name: string]> = [
  [
    "an 80-character title",
    "The Quick Brown Fox Jumps Over The Lazy Dog While Writing Documentation Pages Now",
    "quick-fox",
  ],
  ["an 80-character all-capitals title", "W".repeat(PAGE_TITLE_MAX_LENGTH), "wide"],
  ["an emoji title", "🌍 Hello 👋🏽 world 🎉", "hello-world"],
  ["an RTL title", "مرحبا بالعالم", "arabic-page"],
  ["no title", null, "k3n8vq2p"],
];

for (const [label, title, name] of TEMPLATE_CASES) {
  test(`edge case 17: ${label} renders a full card with no runtime fetch`, async () => {
    const { coverage } = await ogTypefaces();
    const { png, requests } = await render(
      ogHeadline(title, name, coverage),
      `${name}.kept.host`,
    );
    assert.deepEqual(pngSize(png), { width: OG_CARD_WIDTH, height: OG_CARD_HEIGHT });
    assert.deepEqual(requests, [], "D10: the card's fonts are the vendored files, never fetched");
  });
}

test("the generic card renders with no title and no runtime fetch", async () => {
  const { png, requests } = await render(null, null);
  assert.deepEqual(pngSize(png), { width: OG_CARD_WIDTH, height: OG_CARD_HEIGHT });
  assert.deepEqual(requests, []);
});

test("task 016: every theme renders — gradient, orb or none — with no runtime fetch", async () => {
  for (const theme of OG_PALETTE) {
    const { png, requests } = await render("Recipe notes", "recipe-notes.kept.host", theme);
    assert.deepEqual(pngSize(png), { width: OG_CARD_WIDTH, height: OG_CARD_HEIGHT }, theme.name);
    assert.deepEqual(requests, [], theme.name);
  }
});

test("task 016: the theme is in the image — the same card on two themes differs", async () => {
  const [a, b] = await Promise.all(
    OG_PALETTE.slice(0, 2).map((theme) => render(null, null, theme)),
  );
  assert.equal(a!.png.equals(b!.png), false);
});

test("the title is in the image: a named card differs from the generic one", async () => {
  const named = await render("Recipe notes", "recipe-notes.kept.host");
  const generic = await render(null, null);
  assert.equal(named.png.equals(generic.png), false);
});
