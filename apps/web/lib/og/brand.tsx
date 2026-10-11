/** @jsxRuntime automatic @jsxImportSource react */
/**
 * kept's own link preview and icons — E06a §8.
 *
 * One module draws every brand image the control plane serves: the 1200×630
 * preview card the apex and `/founding` link to, the SVG favicon, the
 * `favicon.ico` and the `apple-touch-icon`. Each route that serves one is
 * `force-static`, so these run once, at `next build`, and never per request.
 *
 * ── THE COLOURS ARE READ FROM THE TOKENS, NOT COPIED ─────────────────────────
 *
 * Satori and a standalone SVG resolve no CSS variables, so the images need
 * literal colours. Rather than mirror the hex values here (and drift the day a
 * token changes), `brandTokens()` reads them out of the `:root` block of
 * `app/globals.css` — doc 02's tokens, the same definitions the browser paints
 * with. Nothing in this file names a colour.
 *
 * ── THE MASCOT IS THE ONE GENERATOR, FROZEN ─────────────────────────────────
 *
 * `mascotSvg(MASCOT_REST_T, …)` from `@kept/shared/mascot`, the instant
 * `apps/edge` freezes for its system pages. Its two paints (`currentColor`
 * for the body, `var(--bg)` for the eyes) are substituted with token values,
 * because a standalone SVG has neither an inherited colour nor a variable scope.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import { MASCOT_REST_T, mascotSvg } from "@kept/shared/mascot";

import { OG_CARD_HEIGHT, OG_CARD_WIDTH } from "./card-url";
import { OG_BODY_FAMILY, OG_BODY_WEIGHT, OG_DISPLAY_FAMILY, OG_DISPLAY_WEIGHT, ogTypefaces } from "./font";

/** The `:root` tokens the brand images paint with. */
const TOKEN_NAMES = {
  bg: "--bg",
  text: "--text",
  textSecondary: "--text-secondary",
  accent: "--accent",
  accentSoft: "--accent-soft",
} as const;

export type BrandTokens = Record<keyof typeof TOKEN_NAMES, string>;

/**
 * The light-theme tokens, from `app/globals.css`. `process.cwd()` is `apps/web`
 * wherever this runs (see `./font.ts`). Throws on a token that is missing, so a
 * rename fails the build instead of shipping a black card.
 */
export function brandTokens(): BrandTokens {
  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1];
  if (root === undefined) throw new Error("brand: no :root block in app/globals.css");

  const read = (token: string): string => {
    const value = new RegExp(`(?:^|;|\\s)${token}\\s*:\\s*([^;]+);`).exec(root)?.[1]?.trim();
    if (!value) throw new Error(`brand: token ${token} missing from :root in app/globals.css`);
    return value;
  };
  return Object.fromEntries(
    Object.entries(TOKEN_NAMES).map(([key, token]) => [key, read(token)]),
  ) as BrandTokens;
}

/** The frozen mascot as a standalone SVG: body in `body`, eyes punched in `eyes`. */
export function brandMascotSvg(body: string, eyes: string): string {
  const svg = mascotSvg(MASCOT_REST_T, { maskId: "kept-brand" });
  const painted = svg
    .replace('fill="currentColor"', `fill="${body}"`)
    .replace('fill="var(--bg)"', `fill="${eyes}"`);
  if (painted.includes("currentColor") || painted.includes("var(")) {
    throw new Error("brand: mascotSvg's paints changed; update brandMascotSvg");
  }
  return painted;
}

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/** What a preview card says. */
export interface BrandCardCopy {
  /** The small line over the headline. */
  kicker: string;
  headline: string;
}

const CARD_INSET = 88;
const CARD_MASCOT = 220;

function BrandCard({ kicker, headline, tokens }: BrandCardCopy & { tokens: BrandTokens }) {
  return (
    <div
      style={{
        display: "flex",
        position: "relative",
        width: "100%",
        height: "100%",
        backgroundColor: tokens.bg,
        backgroundImage: `radial-gradient(circle at 84% 26%, ${tokens.accentSoft} 0%, ${tokens.bg} 48%)`,
        color: tokens.text,
      }}
    >
      <div
        style={{
          display: "flex",
          position: "absolute",
          left: CARD_INSET,
          top: CARD_INSET,
          fontFamily: OG_DISPLAY_FAMILY,
          fontWeight: OG_DISPLAY_WEIGHT,
          fontSize: 44,
          letterSpacing: "-0.04em",
          lineHeight: 1,
        }}
      >
        kept
      </div>

      {/* eslint-disable-next-line @next/next/no-img-element -- satori renders an
          element tree, not a DOM; `next/image` has nothing to optimise here. */}
      <img
        src={svgDataUri(brandMascotSvg(tokens.accent, tokens.accentSoft))}
        width={CARD_MASCOT}
        height={CARD_MASCOT}
        alt=""
        style={{ position: "absolute", right: CARD_INSET + 40, top: CARD_INSET }}
      />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          position: "absolute",
          left: CARD_INSET,
          right: CARD_INSET,
          bottom: CARD_INSET,
          gap: 18,
        }}
      >
        <div
          style={{
            display: "flex",
            fontFamily: OG_BODY_FAMILY,
            fontWeight: OG_BODY_WEIGHT,
            fontSize: 26,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: tokens.textSecondary,
          }}
        >
          {kicker}
        </div>
        <div
          style={{
            display: "flex",
            fontFamily: OG_DISPLAY_FAMILY,
            fontWeight: OG_DISPLAY_WEIGHT,
            fontSize: 76,
            lineHeight: 1.05,
            letterSpacing: "-0.02em",
            maxWidth: 820,
          }}
        >
          {headline}
        </div>
      </div>
    </div>
  );
}

/** The 1200×630 preview card, as a PNG response. */
export async function brandCardResponse(copy: BrandCardCopy): Promise<ImageResponse> {
  const { fonts } = await ogTypefaces();
  return new ImageResponse(<BrandCard {...copy} tokens={brandTokens()} />, {
    width: OG_CARD_WIDTH,
    height: OG_CARD_HEIGHT,
    fonts,
  });
}

/** The mascot on a `--bg` square (`background`) or on nothing, as a `size`² PNG response. */
export function brandIconResponse(size: number, { background }: { background: boolean }): ImageResponse {
  const tokens = brandTokens();
  // On a filled square the character gets a margin, as home-screen icons expect.
  const mascot = background ? Math.round(size * 0.78) : size;
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          backgroundColor: background ? tokens.bg : "transparent",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- satori, not a DOM */}
        <img
          src={svgDataUri(brandMascotSvg(tokens.accent, tokens.bg))}
          width={mascot}
          height={mascot}
          alt=""
        />
      </div>
    ),
    { width: size, height: size },
  );
}

/**
 * A single-image `.ico` wrapping a PNG — the PNG-in-ICO form every current
 * browser reads: a 6-byte header, one 16-byte directory entry, then the PNG.
 */
export function icoFromPng(png: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  const HEADER = 6;
  const ENTRY = 16;
  const ico = new Uint8Array(HEADER + ENTRY + png.length);
  const view = new DataView(ico.buffer);
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, 1, true); // one image
  view.setUint8(6, size >= 256 ? 0 : size); // width (0 means 256)
  view.setUint8(7, size >= 256 ? 0 : size); // height
  view.setUint16(10, 1, true); // colour planes
  view.setUint16(12, 32, true); // bits per pixel
  view.setUint32(14, png.length, true); // image bytes
  view.setUint32(18, HEADER + ENTRY, true); // image offset
  ico.set(png, HEADER + ENTRY);
  return ico;
}
