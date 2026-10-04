import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  OG_BODY_FAMILY,
  OG_BODY_WEIGHT,
  OG_DISPLAY_FAMILY,
  OG_DISPLAY_WEIGHT,
  glyphCoverage,
  ogTypefaces,
} from "./font";

/**
 * The OG card's font loader — E06 task 010.
 *
 * The interesting failures here are all silent ones: a buffer that is a *view*
 * into a pool rather than the font, a cache that re-reads on every request, a
 * coverage table that is wrong in a way only a foreign-script title exposes,
 * and a vendored face that has quietly stopped being the face the app ships.
 * None of those look wrong in a render, so they are asserted rather than
 * eyeballed.
 */

/** `\0\1\0\0` — the sfnt version every TrueType file opens with. */
const TTF_MAGIC = Buffer.from([0x00, 0x01, 0x00, 0x00]);

const FONT_DIR = join(process.cwd(), "lib", "og", "fonts");

async function fontFile(name: string): Promise<ArrayBuffer> {
  const buf = await readFile(join(FONT_DIR, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

test("ogTypefaces returns the display and body faces, as real font bytes", async () => {
  const { fonts } = await ogTypefaces();

  assert.equal(fonts.length, 2, "exactly the display and body faces, no mono");

  const display = fonts.find((f) => f.name === OG_DISPLAY_FAMILY);
  const body = fonts.find((f) => f.name === OG_BODY_FAMILY);
  assert.ok(display, `expected a ${OG_DISPLAY_FAMILY} face`);
  assert.ok(body, `expected a ${OG_BODY_FAMILY} face`);
  assert.equal(OG_DISPLAY_FAMILY, "Hanken Grotesk", "the design's display face (decision 1)");
  assert.equal(OG_BODY_FAMILY, "Geist", "the design's body face (decision 1)");

  assert.equal(display.weight, OG_DISPLAY_WEIGHT);
  assert.equal(body.weight, OG_BODY_WEIGHT);

  for (const font of fonts) {
    assert.ok(
      font.data instanceof ArrayBuffer,
      `${font.name} must be an ArrayBuffer — satori cannot take a Buffer view`,
    );
    // The point of the `slice` in `readFontBuffer`: a pooled Buffer's `.buffer`
    // starts with whatever else Node put in the pool, so the magic bytes at
    // offset 0 are the proof the copy was made correctly.
    assert.ok(
      Buffer.from(font.data).subarray(0, 4).equals(TTF_MAGIC),
      `${font.name} does not start with the TrueType magic number`,
    );
    assert.ok(font.data.byteLength > 40_000, `${font.name} is implausibly small`);
  }
});

test("the faces are read once and memoised at module scope", async () => {
  const first = await ogTypefaces();
  const second = await ogTypefaces();

  // Identity, not deep equality: a loader that re-read the files would produce
  // equal-but-distinct buffers and pass a `deepEqual`.
  assert.equal(first, second);
  assert.equal(first.fonts[0]?.data, second.fonts[0]?.data);
  assert.equal(first.coverage, second.coverage);
});

test("glyphCoverage reads what each face can and cannot draw", async () => {
  const hanken = glyphCoverage(await fontFile("HankenGrotesk-SemiBold.ttf"));
  const geist = glyphCoverage(await fontFile("Geist-Regular.ttf"));

  for (const [face, coverage] of [
    ["Hanken Grotesk", hanken],
    ["Geist", geist],
  ] as const) {
    for (const ch of "Aaz09 -.é—…") {
      assert.ok(coverage.has(ch.codePointAt(0)!), `${face} must cover ${JSON.stringify(ch)}`);
    }
    // `.notdef` territory: no emoji, no Arabic, no CJK in either face.
    for (const ch of ["🌍", "م", "日"]) {
      assert.ok(!coverage.has(ch.codePointAt(0)!), `${face} cannot draw ${ch}`);
    }
  }

  // The union is what the card draws from: Cyrillic arrives with Geist.
  const { coverage } = await ogTypefaces();
  assert.ok(coverage.has("П".codePointAt(0)!), "Cyrillic is covered by the union");
  assert.equal(coverage.size, new Set([...hanken, ...geist]).size);
});

test("a file with no cmap fails loudly rather than drawing blanks", () => {
  // A twelve-byte sfnt header that declares zero tables.
  const empty = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer;
  assert.throws(() => glyphCoverage(empty), /no cmap/);
});

test("the vendored Geist is byte-identical to the one the app ships", async () => {
  // `geist`'s package.json declares an `exports` map with no `.` entry, so
  // `require.resolve("geist")` throws and there is no supported way to ask Node
  // where the package is. This walks pnpm's store instead — acceptable in a
  // test, and the reason the runtime loader does NOT do it.
  const store = join(process.cwd(), "..", "..", "node_modules", ".pnpm");
  const dir = (await readdir(store)).find((name) => name.startsWith("geist@"));
  assert.ok(dir, "the geist package is not installed — run pnpm install");

  const shipped = await readFile(
    join(store, dir, "node_modules", "geist", "dist", "fonts", "geist-sans", "Geist-Regular.ttf"),
  );
  const vendored = await readFile(join(FONT_DIR, "Geist-Regular.ttf"));

  // A `geist` upgrade that changes the face would otherwise leave the card set
  // in the old one forever.
  assert.ok(
    shipped.equals(vendored),
    "lib/og/fonts/Geist-Regular.ttf has drifted from the installed geist package — re-copy it",
  );
});
