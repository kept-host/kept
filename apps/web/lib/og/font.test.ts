import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  OG_BODY_FAMILY,
  OG_BODY_WEIGHT,
  OG_DISPLAY_FAMILY,
  OG_DISPLAY_WEIGHT,
  ogFonts,
} from "./font";

/**
 * The OG card's font loader — E06 task 010.
 *
 * The interesting failures here are all silent ones: a buffer that is a *view*
 * into a pool rather than the font, a cache that re-reads on every request, and
 * a vendored face that has quietly stopped being the face the app ships. None of
 * those look wrong in a render, so they are asserted rather than eyeballed.
 */

/** `\0\1\0\0` — the sfnt version every TrueType file opens with. */
const TTF_MAGIC = Buffer.from([0x00, 0x01, 0x00, 0x00]);

test("ogFonts returns both faces, as real font bytes", async () => {
  const fonts = await ogFonts();

  assert.equal(fonts.length, 2, "exactly the display and body faces, no mono");

  const display = fonts.find((f) => f.name === OG_DISPLAY_FAMILY);
  const body = fonts.find((f) => f.name === OG_BODY_FAMILY);
  assert.ok(display, `expected a ${OG_DISPLAY_FAMILY} face`);
  assert.ok(body, `expected an ${OG_BODY_FAMILY} face`);

  assert.equal(display.weight, OG_DISPLAY_WEIGHT);
  assert.equal(body.weight, OG_BODY_WEIGHT);
  assert.equal(display.style, "normal");
  assert.equal(body.style, "normal");

  for (const font of fonts) {
    assert.ok(
      font.data instanceof ArrayBuffer,
      `${font.name} must be an ArrayBuffer — satori cannot take a Buffer view`,
    );
    // The whole point of the `slice` in `readFontBuffer`: a pooled Buffer's
    // `.buffer` starts with whatever else Node put in the pool, so the magic
    // bytes landing at offset 0 is the proof the copy was made correctly.
    assert.ok(
      Buffer.from(font.data).subarray(0, 4).equals(TTF_MAGIC),
      `${font.name} does not start with the TrueType magic number`,
    );
    assert.ok(font.data.byteLength > 50_000, `${font.name} is implausibly small`);
  }
});

test("the buffers are read once and memoised at module scope", async () => {
  const first = await ogFonts();
  const second = await ogFonts();

  // Identity, not deep equality: a loader that re-read the files would produce
  // equal-but-distinct buffers and pass a `deepEqual`, which is exactly the bug
  // the criterion ("fetched once, not per request") is about.
  assert.equal(first, second);
  assert.equal(first[0]?.data, second[0]?.data);
  assert.equal(first[1]?.data, second[1]?.data);
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
    join(store, dir, "node_modules", "geist", "dist", "fonts", "geist-sans", "Geist-SemiBold.ttf"),
  );
  const vendored = await readFile(
    join(process.cwd(), "lib", "og", "fonts", "Geist-SemiBold.ttf"),
  );

  // A `geist` upgrade that changes the face would otherwise leave the card set
  // in the old one forever, and the drift would only ever be noticed by someone
  // holding a card and a dashboard side by side.
  assert.ok(
    shipped.equals(vendored),
    "lib/og/fonts/Geist-SemiBold.ttf has drifted from the installed geist package — re-copy it",
  );
});
