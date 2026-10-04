/**
 * The typefaces the OG card is drawn with — E06 task 010.
 *
 * ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────────
 *
 * `ImageResponse` (satori) needs raw font bytes. `next/font` exposes a
 * `className` and a CSS variable and *no* buffer, and satori resolves no CSS at
 * all, so the app's own font plumbing is unusable here. Something has to hand
 * satori bytes, and this is that something.
 *
 * ── THE FACES ────────────────────────────────────────────────────────────────
 *
 * kept's stack is **Hanken Grotesk (display) · Geist (body) · JetBrains Mono**
 * (Arun's decision 1, 2026-10-04), which is what `lib/fonts.ts` loads and what
 * `globals.css` binds `--font-display` / `--font-body` to. The card uses
 * **Hanken Grotesk SemiBold** for the brand chrome — the wordmark and the
 * headline — and **Geist Regular** for the kicker, the same display/body split
 * every other kept surface uses, so a shared card and the studio it came from
 * read as one product. Mono is not loaded: nothing on the card is set in it, and
 * an unused face resident for the life of the process is a cost with no render
 * behind it.
 *
 * ── WHY THE BYTES ARE VENDORED RATHER THAN RESOLVED OR FETCHED (D10) ─────────
 *
 *   1. **Read them out of `node_modules/geist`.** Rejected. `geist`'s
 *      `package.json` declares an `exports` map with no `.` and no
 *      `./package.json` entry, so `require.resolve("geist")` throws and the only
 *      way in is a hand-built path through pnpm's store layout, which would
 *      break at *runtime on Railway* rather than at build time. It also cannot
 *      supply Hanken Grotesk, which arrives from Google Fonts and never touches
 *      disk.
 *   2. **Fetch them at request time.** Rejected by D10: it makes rendering a
 *      brand asset depend on a third party, adds its latency to a cold card, and
 *      turns a Google Fonts outage into a broken image on every shared link.
 *   3. **Check the bytes in.** Chosen. `./fonts/*.ttf` are ordinary files in the
 *      repo, present in the Railway image because the image contains the
 *      workspace, and readable with one `fs` call. Both faces are SIL Open Font
 *      Licence — `./fonts/HankenGrotesk-LICENSE.txt` and
 *      `./fonts/Geist-LICENSE.txt` travel with them, which is the whole of what
 *      the OFL asks for redistribution.
 *
 * `HankenGrotesk-SemiBold.ttf` is the static TTF `fonts.gstatic.com` serves for
 * `Hanken Grotesk:wght@600` (v12). `Geist-Regular.ttf` is copied verbatim from
 * the installed `geist@1.7.2` package; `font.test.ts` asserts it is still
 * byte-identical to the one that package ships, so an upgrade that changes the
 * face fails a test instead of silently making the card and the app disagree.
 *
 * ── NOTHING OUTSIDE THESE TWO FACES REACHES SATORI ───────────────────────────
 *
 * `next/og` hands satori a `loadAdditionalAsset` hook that cannot be switched
 * off: a glyph neither face has is fetched at render time — emoji from
 * jsdelivr, Cyrillic / CJK / Arabic fallbacks from Google Fonts — and an
 * Arabic run crashes its shaper outright (`lookupType: 5 - substFormat: 3 is
 * not yet supported`), which turns the card into a broken image. Both were
 * measured. So the faces' own `cmap` tables are read here (`glyphCoverage`) and
 * the card draws only code points one of them covers (`ogRenderable` in
 * `./card.tsx`). A title with nothing left falls back to the page's name, which
 * is always `[a-z0-9-]`. No fetch, no crash, no tofu.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where the bytes live, relative to the Next project directory.
 *
 * `process.cwd()` is `apps/web` in every context this module runs in — `next
 * dev`, `next start` under Railway's `pnpm --filter @kept/web start`, and
 * `tsx --test` under `pnpm --filter @kept/web test:unit` — because Next resolves
 * its own project (`.next`, `next.config.ts`) from exactly that directory.
 */
const FONT_DIR = join(process.cwd(), "lib", "og", "fonts");

/** The families satori is told about. Referenced by `fontFamily` in the card. */
export const OG_DISPLAY_FAMILY = "Hanken Grotesk";
export const OG_BODY_FAMILY = "Geist";

/** The single weight of each face that is loaded — see the file header. */
export const OG_DISPLAY_WEIGHT = 600;
export const OG_BODY_WEIGHT = 400;

export interface OgFont {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 600;
  style: "normal";
}

/** The faces, and every code point at least one of them can draw. */
export interface OgTypefaces {
  fonts: OgFont[];
  coverage: ReadonlySet<number>;
}

/**
 * Read one TTF into a standalone `ArrayBuffer`.
 *
 * The `slice` is not ceremony: `readFile` hands back a `Buffer` that may be a
 * *view* into a larger pooled allocation, so `buf.buffer` is frequently not the
 * font — it is the pool. Slicing at the view's own offsets copies out exactly
 * the file's bytes, which is what satori must be given.
 */
async function readFontBuffer(file: string): Promise<ArrayBuffer> {
  const buf = await readFile(join(FONT_DIR, file));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * Every code point a TrueType font maps to a real glyph, from its `cmap` table.
 *
 * Reads the Unicode subtables satori itself reads: format 12 (full repertoire,
 * groups of `[start, end] → glyph`) when present, otherwise format 4 (the BMP,
 * as segments with a delta or an offset into the glyph array). Glyph 0 is
 * `.notdef` — "no glyph" — so a code point mapped there is not covered.
 *
 * @throws when the font has no Unicode `cmap`, which would be a broken vendored
 * file and must fail loudly rather than render a card of blanks.
 */
export function glyphCoverage(font: ArrayBuffer): Set<number> {
  const view = new DataView(font);
  const covered = new Set<number>();

  let cmap = -1;
  const tables = view.getUint16(4);
  for (let i = 0; i < tables; i++) {
    const record = 12 + i * 16;
    if (view.getUint32(record) === 0x636d6170 /* "cmap" */) {
      cmap = view.getUint32(record + 8);
      break;
    }
  }
  if (cmap < 0) throw new Error("font has no cmap table");

  // Unicode subtables: (3,10) and (0,4) are format 12; (3,1) and (0,3) format 4.
  let format12 = -1;
  let format4 = -1;
  const subtables = view.getUint16(cmap + 2);
  for (let i = 0; i < subtables; i++) {
    const record = cmap + 4 + i * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const offset = cmap + view.getUint32(record + 4);
    const format = view.getUint16(offset);
    const unicode = (platform === 3 && (encoding === 1 || encoding === 10)) || platform === 0;
    if (!unicode) continue;
    if (format === 12) format12 = offset;
    else if (format === 4) format4 = offset;
  }

  if (format12 >= 0) {
    const groups = view.getUint32(format12 + 12);
    for (let i = 0; i < groups; i++) {
      const group = format12 + 16 + i * 12;
      const start = view.getUint32(group);
      const end = view.getUint32(group + 4);
      const glyph = view.getUint32(group + 8);
      for (let cp = start; cp <= end; cp++) {
        if (glyph + (cp - start) !== 0) covered.add(cp);
      }
    }
    return covered;
  }

  if (format4 < 0) throw new Error("font has no Unicode cmap subtable");

  const segments = view.getUint16(format4 + 6) / 2;
  const endCodes = format4 + 14;
  const startCodes = endCodes + segments * 2 + 2;
  const deltas = startCodes + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  for (let s = 0; s < segments; s++) {
    const end = view.getUint16(endCodes + s * 2);
    const start = view.getUint16(startCodes + s * 2);
    const delta = view.getInt16(deltas + s * 2);
    const rangeOffsetAt = rangeOffsets + s * 2;
    const rangeOffset = view.getUint16(rangeOffsetAt);
    for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (cp + delta) & 0xffff;
      } else {
        const raw = view.getUint16(rangeOffsetAt + rangeOffset + (cp - start) * 2);
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyph !== 0) covered.add(cp);
    }
  }
  return covered;
}

/**
 * The module-scope cache.
 *
 * The **promise** is memoised rather than the resolved value, so N concurrent
 * first requests share one pair of reads instead of racing N. A rejection is
 * cleared so a transient failure is retried on the next request rather than
 * poisoning the route for the life of the process.
 */
let cached: Promise<OgTypefaces> | null = null;

/** Both faces and their combined coverage, read once per process. */
export function ogTypefaces(): Promise<OgTypefaces> {
  cached ??= Promise.all([
    readFontBuffer("HankenGrotesk-SemiBold.ttf"),
    readFontBuffer("Geist-Regular.ttf"),
  ])
    .then(([display, body]): OgTypefaces => ({
      fonts: [
        {
          name: OG_DISPLAY_FAMILY,
          data: display,
          weight: OG_DISPLAY_WEIGHT,
          style: "normal",
        },
        { name: OG_BODY_FAMILY, data: body, weight: OG_BODY_WEIGHT, style: "normal" },
      ],
      // Satori falls through to the next registered family per glyph, so a code
      // point either face has is drawable.
      coverage: new Set([...glyphCoverage(display), ...glyphCoverage(body)]),
    }))
    .catch((err: unknown) => {
      cached = null;
      throw err;
    });

  return cached;
}
