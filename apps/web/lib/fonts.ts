import { Inter, JetBrains_Mono } from "next/font/google";
import { GeistSans } from "geist/font/sans";

/**
 * Three faces, loaded via next/font for zero layout shift, bound to the
 * `--font-*` CSS variables that app/globals.css feeds into the kept token
 * bridge (Claude Design v2).
 *   - Display: Geist          — headlines, set large & tight
 *   - Body:    Inter          — UI/body text
 *   - Mono:    JetBrains Mono  — labels, code, the mono chips
 */
export const fontDisplay = GeistSans;

export const fontBody = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body-face",
  display: "swap",
});

export const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono-face",
  display: "swap",
});

/** Combined className for the root <html> so all three vars are in scope. */
export const fontVariables = `${fontDisplay.variable} ${fontBody.variable} ${fontMono.variable}`;
