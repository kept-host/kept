import { Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import { GeistSans } from "geist/font/sans";

/**
 * Three faces, loaded via next/font for zero layout shift, bound to the
 * `--font-*-face` CSS variables that app/globals.css feeds into the kept
 * token bridge (--font-display / --font-body / --font-mono).
 *   - Display: Hanken Grotesk (600/700)  — headlines, set large & tight (§5)
 *   - Body:    Geist                      — UI/body text
 *   - Mono:    JetBrains Mono (500)       — labels, the text-link button (§4/§5)
 */
export const fontDisplay = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-display-face",
  display: "swap",
});

export const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500"],
  variable: "--font-mono-face",
  display: "swap",
});

export const fontBody = GeistSans;

/** Combined className for the root <html> so all three vars are in scope. */
export const fontVariables = `${fontDisplay.variable} ${fontMono.variable} ${fontBody.variable}`;
