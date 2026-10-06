import { Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import { GeistSans } from "geist/font/sans";

/**
 * Three faces, loaded via next/font for zero layout shift, bound to the
 * `--font-*` CSS variables that app/globals.css feeds into the kept token
 * bridge. The design's faces (E06, Arun's decision 1):
 *   - Display: Hanken Grotesk — headlines, set large & tight (500/600/700)
 *   - Body:    Geist          — UI/body text
 *   - Mono:    JetBrains Mono — labels, code, the mono chips
 *
 * No component names a family: every surface reads `font-display` /
 * `font-body` / `font-mono`, so a face change is this file + `globals.css`
 * (+ `lib/og/fonts/` for the card, which cannot read CSS).
 */
export const fontDisplay = Hanken_Grotesk({
  subsets: ["latin", "latin-ext"],
  weight: ["500", "600", "700"],
  variable: "--font-display-face",
  display: "swap",
});

export const fontBody = GeistSans;

export const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono-face",
  display: "swap",
});

/** Combined className for the root <html> so all three vars are in scope. */
export const fontVariables = `${fontDisplay.variable} ${fontBody.variable} ${fontMono.variable}`;
