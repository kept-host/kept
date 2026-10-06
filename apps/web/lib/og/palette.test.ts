import assert from "node:assert/strict";
import { test } from "node:test";

import { OG_PALETTE, ogTheme, ogThemeIndex } from "./palette";

/**
 * The thumbnail palette — E06 task 016.
 *
 * Three properties a render cannot show you, because each fails in a way a
 * single card looks fine with: the pick is stable (a page keeps its look across
 * renders, renames and processes), the picks spread (a wall is not ten copies of
 * one theme), and the ink is readable on every entry, not just the ones somebody
 * happened to look at.
 */

const HEX = /^#[0-9A-F]{6}$/;

/** WCAG 2.x relative luminance of a `#RRGGBB` colour. */
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2.x contrast ratio between two `#RRGGBB` colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

test("the contrast helper agrees with WCAG's own reference points", () => {
  assert.equal(contrast("#000000", "#FFFFFF").toFixed(1), "21.0");
  assert.equal(contrast("#777777", "#FFFFFF").toFixed(2), "4.48");
});

test("the palette holds 16–24 themes, every colour a six-digit hex", () => {
  assert.ok(OG_PALETTE.length >= 16 && OG_PALETTE.length <= 24, `${OG_PALETTE.length} themes`);
  for (const theme of OG_PALETTE) {
    assert.match(theme.ink, HEX, theme.name);
    assert.ok(theme.stops.length >= 2, `${theme.name}: a gradient needs two stops`);
    for (const stop of theme.stops) assert.match(stop, HEX, theme.name);
  }
  assert.equal(new Set(OG_PALETTE.map((t) => t.name)).size, OG_PALETTE.length, "names are unique");
  assert.equal(new Set(OG_PALETTE.map((t) => t.image)).size, OG_PALETTE.length, "no two backgrounds alike");
});

test("every theme's ink reaches 4.5:1 against every stop of its background", () => {
  const failures: string[] = [];
  for (const theme of OG_PALETTE) {
    for (const stop of theme.stops) {
      const ratio = contrast(theme.ink, stop);
      if (ratio < 4.5) failures.push(`${theme.name}: ${theme.ink} on ${stop} is ${ratio.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(failures, []);
});

test("backgrounds use only the gradient syntax satori renders, over the theme's own stops", () => {
  for (const theme of OG_PALETTE) {
    assert.match(
      theme.image,
      /^(linear-gradient\(\d+deg, |radial-gradient\(circle at \d+% \d+%, )/,
      theme.name,
    );
    for (const stop of theme.stops) assert.ok(theme.image.includes(stop), `${theme.name}: ${stop}`);
    if (theme.orb !== null) assert.match(theme.orb, /^radial-gradient\(circle at /, theme.name);
  }
});

test("the same id always gets the same theme, whatever its case", () => {
  const id = "3f1c9a52-6d0b-4e8f-9a7c-1b2d3e4f5a6b";
  assert.equal(ogThemeIndex(id), ogThemeIndex(id));
  assert.equal(ogTheme(id), ogTheme(id.toUpperCase()));
  // Pinned, so a change to the hash — which would repaint every page behind a
  // year-long cache — cannot land without this line changing with it.
  assert.equal(ogTheme(id).name, "garden");
});

test("ids spread across the palette: no theme takes more than twice its share of 1,000", () => {
  const counts = new Array<number>(OG_PALETTE.length).fill(0);
  const ids = 1000;
  for (let i = 0; i < ids; i++) counts[ogThemeIndex(crypto.randomUUID())]! += 1;

  const fair = ids / OG_PALETTE.length;
  const report = OG_PALETTE.map((t, i) => `${t.name}=${counts[i]}`).join(" ");
  console.log(`[palette] 1000 random ids, fair share ${fair.toFixed(1)}: ${report}`);
  assert.ok(Math.max(...counts) <= 2 * fair, `a theme took more than ${2 * fair}: ${report}`);
  assert.ok(counts.every((n) => n > 0), `every theme is reachable: ${report}`);
});
