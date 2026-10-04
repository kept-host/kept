/**
 * QR encoding for the anonymous screens — E04 task 008.
 *
 * GENERATED LOCALLY, NEVER FETCHED. The obvious shortcut — an `<img>` pointing
 * at a QR image service — is ruled out twice over: it hands every published slug
 * to an unrelated vendor, and it puts a third-party network dependency on the
 * one screen that has to work when a visitor has nothing but this link. The
 * encoder runs in-process and emits vector geometry; nothing here opens a
 * socket.
 *
 * WHY A DEPENDENCY AND WHY THIS ONE (epic open question 6, decided). Reed–
 * Solomon over GF(256), eight mask patterns and their penalty scoring is a lot
 * of subtle arithmetic to own for a screen decoration, and a wrong mask is a
 * code that scans on one phone and not another. `uqr` is ~79 KB unpacked with
 * ZERO runtime dependencies, ships its own types, and exposes the raw module
 * matrix — so kept renders the SVG itself and the tokens stay in kept's markup
 * rather than in a vendor's colour options.
 *
 * This module is the ONE call site for the dependency: the component below it
 * deals in a matrix and a path, so swapping encoders is a change to two
 * functions. `qrSvg` (task 012's downloads) is built from the same two.
 */
import { encode } from "uqr";

/**
 * Quiet zone in modules. Four is what the QR specification requires; scanners
 * degrade quietly rather than loudly without it, which is the worst way for
 * this to fail.
 */
export const QR_QUIET_ZONE_MODULES = 4;

export interface QrMatrix {
  /** Width and height in modules, quiet zone included. */
  size: number;
  /** `true` = dark module, addressed `modules[y][x]`. */
  modules: boolean[][];
}

/**
 * Encode a value into a QR matrix.
 *
 * Error correction `M` (~15% recoverable) — the usual choice for a URL shown on
 * a screen: `L` gives up too much to a smudged camera, `Q`/`H` grow the module
 * count and shrink each module at a fixed pixel size, which is the thing that
 * actually breaks a scan.
 */
export function qrMatrix(value: string): QrMatrix {
  const result = encode(value, { ecc: "M", border: QR_QUIET_ZONE_MODULES });
  return { size: result.size, modules: result.data };
}

/**
 * SVG path data covering every dark module — one `<path>` rather than ~700
 * `<rect>` elements, because this markup is serialized into the RSC payload of
 * every result and claim page render.
 */
export function qrPath(matrix: QrMatrix): string {
  let d = "";
  for (let y = 0; y < matrix.size; y++) {
    const row = matrix.modules[y]!;
    for (let x = 0; x < matrix.size; x++) {
      if (row[x]) d += `M${x} ${y}h1v1h-1z`;
    }
  }
  return d;
}

/**
 * The QR as a standalone SVG document — what "Download SVG" saves and what
 * "Download PNG" rasterises (page detail's Share section, E06 task 012).
 *
 * NOT `components/kept/qr.tsx`'s markup: that one paints with
 * `var(--surface)` and `currentColor`, which mean nothing outside the studio's
 * stylesheet, so a file saved from it would open as a black square or nothing
 * at all. A file must carry its own colours, and a QR code is read as dark
 * modules on a light field — so `black` on `white`, by name. The geometry is
 * the same `qrPath` the screen draws, from the same `qrMatrix`.
 */
export function qrSvg(value: string): string {
  const matrix = qrMatrix(value);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${matrix.size} ${matrix.size}" width="${matrix.size * 8}" height="${matrix.size * 8}" shape-rendering="crispEdges"><rect width="${matrix.size}" height="${matrix.size}" fill="white"/><path d="${qrPath(matrix)}" fill="black"/></svg>`;
}
