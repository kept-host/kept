/** @jsxRuntime automatic @jsxImportSource react */
/**
 * The OG card's layout — E06 task 010 (D10).
 *
 * The composition is the Page Card thumbnail template from Claude Design
 * (`kept Page Card.dc.html`: `t.bg`, `t.deco`, `t.kicker`, `t.head`): a
 * full-bleed background, a decoration top right, and a kicker over a large
 * headline anchored bottom left. The per-page themes in the design (gradients,
 * Space Grotesk, Press Start 2P, …) are sample data; the real thumbnail is this
 * one card, in kept's own palette and faces, with the mascot as the decoration
 * and the wordmark as the brand mark.
 *
 * (The pragma above is for `tsx --test`, which compiles this file without
 * Next's JSX settings; `card.test.ts` renders the card for real.)
 *
 * ⚠️ THIS FILE IS THE SINGLE DOCUMENTED EXCEPTION TO "TOKENS ARE LAW."
 *
 * Satori resolves no CSS variables, no `@theme`, no Tailwind class and no
 * cascade: it lays out a React element tree against literal inline styles and
 * hands the result to resvg. There is no mechanism by which `bg-surface` or
 * `var(--accent)` could mean anything here. So every colour below is written
 * out — and every one of them is **copied from the token definition in
 * `app/globals.css`, not chosen**, with the token it mirrors named beside it.
 * `OG_TOKENS` exists so those literals sit in one annotated block rather than
 * scattered through the markup, which is what makes a token change reviewable.
 *
 * ── WHAT THE CARD IS ALLOWED TO SAY ─────────────────────────────────────────
 *
 * The route is unauthenticated by necessity (it is consumed as an `<img>` and by
 * crawlers), so the card renders **only what is already public**: the page's
 * title — which the page serves to the world — or its name, which is its
 * hostname. Plus the brand mark. No owner, no counts, no status, no clock: a
 * countdown baked into an `immutable` response would be wrong within hours and
 * wrong forever, and the studio paints the draft chip over the thumbnail
 * itself, from the live clock.
 */
import { MASCOT_REST_T, MASCOT_VIEWBOX, mascotFrame } from "@kept/shared/mascot";

import { OG_BODY_FAMILY, OG_BODY_WEIGHT, OG_DISPLAY_FAMILY, OG_DISPLAY_WEIGHT } from "./font";

/**
 * The colour literals, each mirroring a `:root` token in `app/globals.css`.
 *
 * ⚠️ Light values only, and that is correct: an `og:image` is a flat file with
 * no viewer preference attached to it, so there is no dark counterpart to serve.
 * v1 is light-only anyway (`app/providers.tsx` pins `forcedTheme="light"`).
 */
const OG_TOKENS = {
  /** `--bg` */ bg: "#faf8f4",
  /** `--accent-soft` */ accentSoft: "#ede9ff",
  /** `--text` */ text: "#1a1714",
  /** `--text-secondary` */ textSecondary: "#6b645c",
  /** `--accent` */ accent: "#6d4aff",
} as const;

/** Something a reader can read: a letter or a digit in any script. */
const READABLE = /[\p{L}\p{N}]/u;

/**
 * `text`, reduced to what the vendored faces can draw — or `null` when nothing
 * readable survives.
 *
 * NFC first, so a decomposed `e` + `◌́` becomes the `é` the faces carry. Then
 * every code point neither face covers is dropped (emoji, Arabic, Hebrew, CJK,
 * variation selectors, ZWJ): drawing them would make `next/og` fetch a fallback
 * at render time, which D10 forbids and which crashes outright on Arabic — see
 * `./font.ts`. Whitespace is collapsed after, so a dropped emoji leaves no gap.
 */
export function ogRenderable(text: string, coverage: ReadonlySet<number>): string | null {
  const kept = Array.from(text.normalize("NFC"))
    .map((ch) => (/\s/u.test(ch) ? " " : ch))
    .filter((ch) => ch === " " || coverage.has(ch.codePointAt(0)!))
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
  return READABLE.test(kept) ? kept : null;
}

/**
 * The headline a named card carries: `title ?? name`, drawable.
 *
 * A title whose every readable character is outside the faces (an all-Arabic
 * or all-emoji title) falls back to the name, exactly like a page with no title
 * — the name is a hostname label, `[a-z0-9-]`, always drawable. Length is the
 * layout's business, not this function's: the headline block clamps to
 * `OG_HEADLINE_LINES` and ellipsises, so a title of any width fits.
 */
export function ogHeadline(
  title: string | null,
  name: string,
  coverage: ReadonlySet<number>,
): string {
  return (title === null ? null : ogRenderable(title, coverage)) ?? name;
}

/**
 * How many lines the headline may take before it is cut with an ellipsis.
 *
 * Settled by rendering cards and looking at them. At Hanken Grotesk SemiBold
 * 64 px across 976 px a title-case sentence sets ~25 characters a line, so an
 * 80-character title (`PAGE_TITLE_MAX_LENGTH`, the storage cap) is three lines,
 * occasionally cut short on the third; three lines is also the most the block
 * holds with the kicker, the wordmark and the mascot still clear above it.
 * Clamping by *lines* rather than by characters is what makes an all-capitals
 * or an unbroken title fit too — a character cap that suits average glyphs is
 * three lines too many for `W`.
 */
const OG_HEADLINE_LINES = 3;

/**
 * The mascot, as an `<img>`-able data URI — the template's decoration.
 *
 * `mascotSvg` from `@kept/shared/mascot` cannot be used as-is: it paints the
 * body `currentColor` and the eyes `var(--bg)`, and a standalone SVG handed to
 * resvg has neither an inherited colour nor a variable scope. So the *geometry*
 * is reused — `mascotFrame`, the pure function both the browser and the Worker
 * already draw from — and only the two paints are substituted with the literals
 * above. There is still exactly one generator.
 *
 * Frozen at `MASCOT_REST_T`, the same instant `apps/edge` renders and the same
 * one `apps/web` rests on under reduced motion. Built once at module load.
 */
const MASCOT_DATA_URI = (() => {
  const { d, eyes } = mascotFrame(MASCOT_REST_T, { maskId: "og" });
  const eyeMarkup = eyes
    .map((e) => `<path d="${e.d}" transform="${e.transform}"/>`)
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MASCOT_VIEWBOX}">` +
    `<mask id="og" maskUnits="userSpaceOnUse" x="-100" y="-100" width="200" height="200">` +
    `<path d="${d}" fill="white"/>` +
    `</mask>` +
    // `--accent`: the body, exactly as `text-accent` paints it in the browser.
    `<path d="${d}" fill="${OG_TOKENS.accent}"/>` +
    // The eyes punch through to whatever is behind the character. On this card
    // that is the glow it sits in, so `--accent-soft`.
    `<g mask="url(#og)" fill="${OG_TOKENS.accentSoft}">${eyeMarkup}</g>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
})();

/**
 * The content inset. 9 % vertically, as the template has it; horizontally a
 * little more than its 7 %, because the studio shows this image in a 16:10 box
 * (`object-cover`), which crops 96 px off each side of a 1200 × 630 card — the
 * kicker and the headline must start inside what survives.
 */
const INSET_X = 112;
const INSET_Y = 57;

/** What the generic card says in place of a page's name and address. */
const GENERIC_HEADLINE = "A page, kept.";
const GENERIC_KICKER = "Free, permanent, dead-simple hosting for one HTML file.";

export interface OgCardProps {
  /** `ogHeadline(...)`, resolved by the caller. `null` on the generic card. */
  headline: string | null;
  /** `{name}.{servingBaseDomain()}` — the kicker. `null` when there is none to show. */
  host: string | null;
}

/**
 * The card.
 *
 * Every `div` carries an explicit `display` — satori requires it and silently
 * mislays children that do not have it. The arrangement is the thumbnail
 * template's: the decoration top right, the kicker + headline bottom left.
 *
 * The **generic** card (`headline` `null`) is what an unknown, malformed or
 * non-`live` id renders. It is the same frame at the same size with the same
 * brand mark and **no page title** (edge case 17, AC45), so a probe learns
 * nothing from the response's status, headers or shape — see the route for how
 * far that uniformity goes and where it necessarily stops.
 */
export function OgCard({ headline, host }: OgCardProps) {
  return (
    <div
      style={{
        display: "flex",
        position: "relative",
        width: "100%",
        height: "100%",
        // `t.bg`: the page background, with an `--accent-soft` glow behind the
        // decoration — the sample template's radial composition in kept's palette.
        backgroundColor: OG_TOKENS.bg,
        backgroundImage: `radial-gradient(circle at 86% 22%, ${OG_TOKENS.accentSoft} 0%, ${OG_TOKENS.bg} 46%)`,
      }}
    >
      {/* Brand mark, top left. */}
      <div
        style={{
          display: "flex",
          position: "absolute",
          left: INSET_X,
          top: INSET_Y,
          fontFamily: OG_DISPLAY_FAMILY,
          fontWeight: OG_DISPLAY_WEIGHT,
          fontSize: 44,
          letterSpacing: "-0.04em",
          lineHeight: 1,
          // `--text`
          color: OG_TOKENS.text,
        }}
      >
        kept
      </div>

      {/* `t.deco`: the mascot, top right. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- satori renders an
          element tree, not a DOM; `next/image` has nothing to optimise here. */}
      <img
        src={MASCOT_DATA_URI}
        width={168}
        height={168}
        alt=""
        style={{ position: "absolute", right: INSET_X, top: INSET_Y }}
      />

      {/* `t.kicker` over `t.head`, bottom left. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          position: "absolute",
          left: INSET_X,
          right: INSET_X,
          bottom: INSET_Y,
          gap: 16,
        }}
      >
        <div
          style={{
            display: "block",
            fontFamily: OG_BODY_FAMILY,
            fontWeight: OG_BODY_WEIGHT,
            fontSize: 24,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            // `--text-secondary`: the template's ink at 80 %.
            color: OG_TOKENS.textSecondary,
          }}
        >
          {host ?? GENERIC_KICKER}
        </div>
        <div
          style={{
            display: "block",
            lineClamp: OG_HEADLINE_LINES,
            // An unbroken title breaks inside the word rather than off the card.
            wordBreak: "break-word",
            fontFamily: OG_DISPLAY_FAMILY,
            fontWeight: OG_DISPLAY_WEIGHT,
            fontSize: 64,
            lineHeight: 1.05,
            letterSpacing: "-0.02em",
            color: OG_TOKENS.text,
          }}
        >
          {headline ?? GENERIC_HEADLINE}
        </div>
      </div>
    </div>
  );
}
