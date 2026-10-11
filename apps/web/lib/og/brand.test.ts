/**
 * kept's link-preview card and icons (E06a §8, AC22), rendered for real with
 * `next/og` — the same calls the `force-static` routes make at build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { OG_CARD_HEIGHT, OG_CARD_WIDTH } from "./card-url";
import {
  brandCardResponse,
  brandIconResponse,
  brandMascotSvg,
  brandTokens,
  icoFromPng,
} from "./brand";
import { FOUNDING_CARD, LANDING_CARD, foundingMetadata, landingMetadata } from "./preview";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from a PNG's IHDR, after asserting the signature. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  assert.deepEqual([...bytes.subarray(0, 8)], PNG_SIGNATURE, "not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

test("brandTokens reads every colour from the :root block of app/globals.css", () => {
  const tokens = brandTokens();
  for (const [name, value] of Object.entries(tokens)) {
    assert.match(value, /^#[0-9a-f]{6}$/i, `${name} = ${value}`);
  }
  // The light theme, not the dark block that follows it.
  assert.notEqual(tokens.bg, tokens.text);
});

test("brandMascotSvg is the shared frozen mascot with both paints resolved", () => {
  const svg = brandMascotSvg("#000001", "#000002");
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(svg.includes('fill="#000001"') && svg.includes('fill="#000002"'), svg);
  assert.ok(!svg.includes("currentColor") && !svg.includes("var("), svg);
});

for (const [name, copy] of [
  ["apex", LANDING_CARD],
  ["founding", FOUNDING_CARD],
] as const) {
  test(`AC22: the ${name} card is a ${OG_CARD_WIDTH}×${OG_CARD_HEIGHT} PNG`, async () => {
    const response = await brandCardResponse(copy);
    assert.equal(response.headers.get("content-type"), "image/png");
    const size = pngSize(new Uint8Array(await response.arrayBuffer()));
    assert.deepEqual(size, { width: 1200, height: 630 });
  });
}

test("AC22: the apple-touch-icon is a 180×180 PNG", async () => {
  const png = new Uint8Array(await brandIconResponse(180, { background: true }).arrayBuffer());
  assert.deepEqual(pngSize(png), { width: 180, height: 180 });
});

test("AC22: favicon.ico is a one-image ICO wrapping a 32×32 PNG", async () => {
  const png = new Uint8Array(await brandIconResponse(32, { background: false }).arrayBuffer());
  const ico = icoFromPng(png, 32);
  const view = new DataView(ico.buffer);
  assert.equal(view.getUint16(0, true), 0, "reserved");
  assert.equal(view.getUint16(2, true), 1, "type: icon");
  assert.equal(view.getUint16(4, true), 1, "image count");
  assert.equal(ico[6], 32);
  assert.equal(ico[7], 32);
  assert.equal(view.getUint32(14, true), png.length, "image size");
  assert.equal(view.getUint32(18, true), 22, "image offset");
  assert.deepEqual(pngSize(ico.subarray(22)), { width: 32, height: 32 });
});

test("AC22: previews carry title, description, an absolute 1200×630 og:image and summary_large_image", () => {
  const saved = { app: process.env.NEXT_PUBLIC_APP_URL, open: process.env.NEXT_PUBLIC_KEPT_OPEN };
  process.env.NEXT_PUBLIC_APP_URL = "https://app.kept.example";
  try {
    for (const [metadata, image] of [
      [landingMetadata, "https://kept.example/og.png"],
      [foundingMetadata, "https://kept.example/founding/og.png"],
    ] as const) {
      process.env.NEXT_PUBLIC_KEPT_OPEN = "false";
      const m = metadata();
      assert.ok(typeof m.description === "string" && m.description.length > 0);
      assert.deepEqual(m.twitter, {
        card: "summary_large_image",
        title: m.openGraph?.title,
        description: m.description,
        images: [{ url: image, width: 1200, height: 630, alt: m.openGraph?.title }],
      });
      assert.equal(m.openGraph?.description, m.description);
      assert.deepEqual(m.openGraph?.images, m.twitter?.images);
      assert.deepEqual(m.title, { absolute: m.openGraph?.title });
    }
    // Closed frames the landing pitch with the opening date; open does not.
    assert.match(String(landingMetadata().description), /^kept opens in December\. /);
    process.env.NEXT_PUBLIC_KEPT_OPEN = "true";
    assert.doesNotMatch(String(landingMetadata().description), /December/);
  } finally {
    for (const [key, value] of [
      ["NEXT_PUBLIC_APP_URL", saved.app],
      ["NEXT_PUBLIC_KEPT_OPEN", saved.open],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
