import { qrMatrix, qrPath } from "@/lib/qr/qr-code";

/**
 * The QR code on the result and claim screens — inline SVG, encoded in process.
 *
 * NO `<img>`, NO REMOTE URL, NO CANVAS. The markup below contains geometry and
 * two token references and nothing else, so the component renders identically
 * with the network unplugged (see `lib/qr/qr-code.test.ts`, which renders it
 * with `fetch` rigged to throw).
 *
 * THEMING: the modules are `currentColor` and the quiet zone is `var(--surface)`,
 * so a single pair of token classes carries both themes — dark modules on the
 * card's own surface in light mode, light modules on the dark surface in dark
 * mode. No hex, and no second copy of the code for the other theme.
 */
export function QrCode({
  value,
  label,
  size = 148,
}: {
  /** The URL to encode. */
  value: string;
  /** Accessible name — say where the code leads, not that it is a QR code. */
  label: string;
  /** Rendered edge length in CSS pixels. */
  size?: number;
}) {
  const matrix = qrMatrix(value);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${matrix.size} ${matrix.size}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="block rounded-[var(--r-sm)] text-text"
    >
      <rect width={matrix.size} height={matrix.size} fill="var(--surface)" />
      <path d={qrPath(matrix)} fill="currentColor" />
    </svg>
  );
}
