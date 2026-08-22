/**
 * The typefaces the OG card is drawn with, as `ArrayBuffer`s — E06 task 010.
 *
 * ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────────
 *
 * `ImageResponse` (satori) needs raw font bytes. `next/font/google` exposes a
 * `className` and a CSS variable and *no* buffer, and satori resolves no CSS at
 * all, so the app's own font plumbing is unusable here. Something has to hand
 * satori bytes, and this is that something.
 *
 * ── THE FACES, AND WHY THESE TWO ─────────────────────────────────────────────
 *
 * kept's stack is **Geist (display) · Inter (body) · JetBrains Mono**, which is
 * what `lib/fonts.ts` loads and what `globals.css` binds `--font-display` /
 * `--font-body` to. CLAUDE.md said "Hanken Grotesk (display) / Geist (body)"
 * until this task; Hanken Grotesk appears nowhere in the repo, so the prose was
 * the thing that had drifted and it was corrected rather than the code. The card
 * therefore uses **Geist SemiBold** for the headline and wordmark and **Inter
 * Regular** for the chip and the URL line — the same display/body split every
 * other kept surface uses, so a shared card and the dashboard it came from read
 * as one product.
 *
 * Mono is not loaded. Nothing on the card is set in it, and an unused 100 KB+
 * face resident for the life of the process is a cost with no render behind it.
 *
 * ── WHY THE BYTES ARE VENDORED RATHER THAN RESOLVED OR FETCHED ───────────────
 *
 * Three routes were considered:
 *
 *   1. **Read them out of `node_modules/geist`.** Rejected. `geist`'s
 *      `package.json` declares an `exports` map with no `.` and no
 *      `./package.json` entry, so `require.resolve("geist")` throws
 *      ERR_PACKAGE_PATH_NOT_EXPORTED and the only way in is a hand-built path
 *      through pnpm's store layout. That path is not part of any package's
 *      public contract, it differs between pnpm layouts, and it would break at
 *      *runtime on Railway* rather than at build time. It also cannot supply
 *      Inter, which arrives from Google Fonts and never touches disk.
 *   2. **Fetch them at request time.** Rejected. It makes rendering a brand
 *      asset depend on an outbound call to a third party, adds its latency to a
 *      cold card, and turns a Google Fonts outage into a broken image on every
 *      shared link. Satori also cannot use woff2 — the format that CDN serves
 *      by default — so it needs the old-user-agent trick to get TTF, which is a
 *      fragile thing to put on a production path.
 *   3. **Check the bytes in.** Chosen. `./fonts/*.ttf` are ordinary files in the
 *      repo, present in the Railway image because the image contains the
 *      workspace, immune to dependency pruning and to `node_modules` layout, and
 *      readable with one `fs` call. Both faces are SIL Open Font Licence —
 *      `./fonts/Geist-LICENSE.txt` and `./fonts/Inter-LICENSE.txt` travel with
 *      them, which is the whole of what the OFL asks for redistribution.
 *
 * `Inter-Regular.ttf` is the exact static TTF `fonts.gstatic.com` serves for
 * `Inter:wght@400` (v20) — the same binary `next/font/google` downloads at build
 * time. `Geist-SemiBold.ttf` is copied verbatim from the installed `geist@1.7.2`
 * package; `font.test.ts` asserts it is still byte-identical to the one that
 * package ships, so an upgrade that changes the face fails a test instead of
 * silently making the card and the app disagree.
 *
 * ⚠️ NEITHER FACE COVERS CJK, ARABIC OR EMOJI, and no fallback is loaded. A
 * title in those scripts renders as blanks. Fixing it means shipping a Noto
 * fallback — several megabytes, resident, for a minority of cards — and that is
 * a deliberate no, not an oversight. Inter is the *full* Google static rather
 * than the 65 KB latin subset precisely so the Latin-adjacent cases Geist misses
 * (Cyrillic, Greek, Vietnamese) still land, since satori falls through to the
 * second registered family per glyph.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where the bytes live, relative to the Next project directory.
 *
 * `process.cwd()` is `apps/web` in every context this module runs in — `next
 * dev`, `next start` under Railway's `pnpm --filter @kept/web start`, and
 * `tsx --test` under `pnpm --filter @kept/web test:unit` — because Next resolves
 * its own project (`.next`, `next.config.ts`) from exactly that directory. If
 * cwd were anything else the app would not have started, so there is no case
 * where this resolves wrongly but everything else works.
 */
const FONT_DIR = join(process.cwd(), "lib", "og", "fonts");

/** The families satori is told about. Referenced by `fontFamily` in the card. */
export const OG_DISPLAY_FAMILY = "Geist";
export const OG_BODY_FAMILY = "Inter";

/** The single weight of each face that is loaded — see the file header. */
export const OG_DISPLAY_WEIGHT = 600;
export const OG_BODY_WEIGHT = 400;

export interface OgFont {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 600;
  style: "normal";
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
 * The module-scope cache.
 *
 * The **promise** is memoised rather than the resolved value, so N concurrent
 * first requests share one pair of reads instead of racing N. A rejection is
 * cleared so a transient failure is retried on the next request rather than
 * poisoning the route for the life of the process.
 */
let cached: Promise<OgFont[]> | null = null;

/** Both faces, read once per process. */
export function ogFonts(): Promise<OgFont[]> {
  cached ??= Promise.all([
    readFontBuffer("Geist-SemiBold.ttf"),
    readFontBuffer("Inter-Regular.ttf"),
  ])
    .then(([display, body]): OgFont[] => [
      {
        name: OG_DISPLAY_FAMILY,
        data: display,
        weight: OG_DISPLAY_WEIGHT,
        style: "normal",
      },
      { name: OG_BODY_FAMILY, data: body, weight: OG_BODY_WEIGHT, style: "normal" },
    ])
    .catch((err: unknown) => {
      cached = null;
      throw err;
    });

  return cached;
}
