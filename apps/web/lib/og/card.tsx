/**
 * The OG card's layout — E06 task 010.
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
 * scattered through the markup, which is what makes a token change reviewable:
 * one file, one table, and the greps that hunt for stray hex in this repo find
 * a table with its provenance written down instead of a mystery.
 *
 * The exception stops at this route. Every other surface E06 ships paints from
 * token classes.
 *
 * ── WHAT THE CARD IS ALLOWED TO SAY ─────────────────────────────────────────
 *
 * The route is unauthenticated by necessity (it is consumed as an `<img>` and by
 * crawlers), so the card renders **only what is already public**: the page's own
 * `<title>` — which the page serves to the world — or its slug, which is its
 * hostname. Plus the draft/kept chip and the brand mark. No owner, no email, no
 * counts, no status beyond draft/kept. A card that leaked anything else would
 * leak it to anyone holding a guessed UUID.
 *
 * ── NO COUNTDOWN, DELIBERATELY ──────────────────────────────────────────────
 *
 * The chip says "Draft" or "Kept" and never "6 days left". `draftCountdown` is a
 * function of `now`, and this response is cached `immutable`: a countdown baked
 * into it would be wrong within hours and wrong forever. The card is the one
 * surface where the clock must not appear.
 */
import { MASCOT_REST_T, MASCOT_VIEWBOX, mascotFrame } from "@kept/shared/mascot";

import {
  OG_BODY_FAMILY,
  OG_BODY_WEIGHT,
  OG_DISPLAY_FAMILY,
  OG_DISPLAY_WEIGHT,
} from "./font";

/** The `og:image` aspect every crawler expects, and what the dashboard crops. */
export const OG_CARD_WIDTH = 1200;
export const OG_CARD_HEIGHT = 630;

/**
 * The colour literals, each mirroring a `:root` token in `app/globals.css`.
 *
 * ⚠️ Light values only, and that is correct: an `og:image` is a flat file with
 * no viewer preference attached to it, so there is no dark counterpart to serve.
 * v1 is light-only anyway (`app/providers.tsx` pins `forcedTheme="light"`), so
 * the card matches every surface a reader could have come from.
 */
const OG_TOKENS = {
  /** `--bg` */ bg: "#faf8f4",
  /** `--surface` */ surface: "#ffffff",
  /** `--text` */ text: "#1a1714",
  /** `--text-secondary` */ textSecondary: "#6b645c",
  /** `--border` */ border: "#e5e0d8",
  /** `--accent` */ accent: "#6d4aff",
  /** `--warning` */ warning: "#e0a33a",
  /** `--shadow-md`, as satori's `boxShadow` takes it */
  shadowMd: "0 4px 16px rgba(40, 30, 20, 0.08)",
  /** `--r-xl` */ radiusXl: 24,
  /** `--r-pill` */ radiusPill: 999,
} as const;

/**
 * How much of a title the headline may carry, in code points.
 *
 * ⚠️ A DISPLAY RULE, NOT A STORAGE RULE. `PAGE_TITLE_MAX_LENGTH` (`@kept/shared`)
 * bounds what the database holds; this bounds what fits on a 1200×630 card
 * without the headline eating the chip and the URL line. The two are
 * deliberately different numbers and neither may be derived from the other.
 *
 * Settled by rendering cards and looking at them, not by arithmetic — the
 * criterion is explicit about that, and the arithmetic would have got it wrong.
 * The headline is Geist SemiBold at 60 px inside 992 px of content width. An
 * average-width estimate says ~30 characters per line; a real title-case English
 * sentence measured **~24**, because capitals and the words people actually name
 * pages with are wider than the average glyph. At 90 characters that is four
 * lines, and the rendered card showed the headline pressed against both the
 * brand row above it and the URL line below, with `space-between` collapsed to
 * nothing — a wall of text rather than a card.
 *
 * 72 is three lines at the measured width, which leaves the three zones visibly
 * separated on the widest realistic title while still carrying most of what
 * anyone actually types. A longer title is cut on a code point boundary — never
 * through a surrogate pair — and given an ellipsis, so it reads as truncated
 * rather than as mysteriously ending mid-word.
 */
export const OG_TITLE_MAX_CHARS = 72;

/** The ellipsis appended to a clamped headline. One character, not three dots. */
const ELLIPSIS = "…";

/**
 * Clamp a headline to `OG_TITLE_MAX_CHARS`.
 *
 * `Array.from` splits on code points, so an emoji or an astral-plane character
 * is never cut in half into a replacement glyph — the same reasoning, and the
 * same technique, as `extractPageTitle`'s storage cap.
 *
 * Exported for its unit test: the clamp is the one piece of logic on this
 * surface that can be wrong in a way a render does not show you.
 */
export function clampOgTitle(value: string): string {
  const points = Array.from(value);
  if (points.length <= OG_TITLE_MAX_CHARS) return value;
  return points.slice(0, OG_TITLE_MAX_CHARS).join("").trimEnd() + ELLIPSIS;
}

/**
 * The mascot, as an `<img>`-able data URI.
 *
 * `mascotSvg` from `@kept/shared/mascot` cannot be used as-is: it paints the
 * body `currentColor` and the eyes `var(--bg)`, and a standalone SVG handed to
 * resvg has neither an inherited colour nor a variable scope. So the *geometry*
 * is reused — `mascotFrame`, the pure function both the browser and the Worker
 * already draw from — and only the two paints are substituted with the literals
 * above. The character therefore cannot drift from the one on `/auth` and on the
 * Worker's 404: there is still exactly one generator.
 *
 * Frozen at `MASCOT_REST_T`, the same instant `apps/edge` renders and the same
 * one `apps/web` rests on under reduced motion. A still image has no other
 * defensible `t`.
 *
 * Built once at module load — `mascotFrame` is pure, and the card's mascot never
 * varies.
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
    // that is the surface panel, not the page background — so `--surface`, where
    // a browser would have resolved `var(--bg)` against the panel it sits on.
    `<g mask="url(#og)" fill="${OG_TOKENS.surface}">${eyeMarkup}</g>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
})();

/** Draft or kept — `expires_at != null` and nothing else. */
export type OgCardPhase = "draft" | "kept";

export interface OgCardProps {
  /** `title ?? slug`, already resolved by the caller. `null` on the generic card. */
  headline: string | null;
  /** `{slug}.{servingBaseDomain()}`, or `null` when there is no page to name. */
  host: string | null;
  /** `null` on the generic card, which claims no page and so claims no phase. */
  phase: OgCardPhase | null;
}

/**
 * The chip. Mirrors `components/kept/draft-chip.tsx` — pill, hairline border,
 * surface fill, a phase-coloured dot — minus the countdown, for the reason in
 * the file header.
 *
 * The label is set in the body face rather than the mono face `.mono-label`
 * uses. Loading JetBrains Mono for two words would put a third 100 KB+ font
 * resident for the life of the process; the uppercase and the tracking, which
 * are what the label actually reads as, are reproduced here.
 */
function Chip({ phase }: { phase: OgCardPhase }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        border: `1px solid ${OG_TOKENS.border}`,
        borderRadius: OG_TOKENS.radiusPill,
        backgroundColor: OG_TOKENS.surface,
        padding: "10px 24px",
      }}
    >
      <div
        style={{
          width: 12,
          height: 12,
          borderRadius: OG_TOKENS.radiusPill,
          // `--accent` for kept, `--warning` for draft — `DOT_CLASS` in
          // `draft-chip.tsx`. Its third state, `expired`, is a clock reading and
          // so cannot appear on an immutable image.
          backgroundColor: phase === "kept" ? OG_TOKENS.accent : OG_TOKENS.warning,
        }}
      />
      <div
        style={{
          fontFamily: OG_BODY_FAMILY,
          fontWeight: OG_BODY_WEIGHT,
          fontSize: 22,
          letterSpacing: "0.08em",
          color: OG_TOKENS.textSecondary,
        }}
      >
        {phase === "kept" ? "KEPT" : "DRAFT"}
      </div>
    </div>
  );
}

/**
 * The card.
 *
 * Every `div` carries an explicit `display` — satori requires it and silently
 * mislays children that do not have it. The tree is deliberately shallow: a
 * page background, one surface panel, three rows.
 *
 * The **generic** card (`headline`, `host` and `phase` all `null`) is what an
 * unknown, malformed or non-existent id renders. It is the same frame at the
 * same size with the same brand mark, so a probe learns nothing from the
 * response's status, headers or shape — see the route for exactly how far that
 * uniformity goes and where it necessarily stops.
 */
export function OgCard({ headline, host, phase }: OgCardProps) {
  return (
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        // `--bg`
        backgroundColor: OG_TOKENS.bg,
        padding: 48,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          flex: 1,
          // `--surface`
          backgroundColor: OG_TOKENS.surface,
          border: `1px solid ${OG_TOKENS.border}`,
          borderRadius: OG_TOKENS.radiusXl,
          boxShadow: OG_TOKENS.shadowMd,
          padding: 56,
        }}
      >
        {/* Brand mark, and the chip when there is a page to describe. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- satori renders
                an element tree, not a DOM; `next/image` has nothing to optimise
                here and would not run. */}
            <img src={MASCOT_DATA_URI} width={64} height={64} alt="" />
            <div
              style={{
                fontFamily: OG_DISPLAY_FAMILY,
                fontWeight: OG_DISPLAY_WEIGHT,
                fontSize: 40,
                letterSpacing: "-0.02em",
                // `--text`
                color: OG_TOKENS.text,
              }}
            >
              kept
            </div>
          </div>
          {phase ? <Chip phase={phase} /> : null}
        </div>

        {/* The headline. `title ?? slug`, clamped by the caller. */}
        <div
          style={{
            display: "flex",
            fontFamily: OG_DISPLAY_FAMILY,
            fontWeight: OG_DISPLAY_WEIGHT,
            fontSize: 60,
            lineHeight: 1.15,
            letterSpacing: "-0.02em",
            color: OG_TOKENS.text,
          }}
        >
          {headline ?? "A page, kept."}
        </div>

        {/* The public address, or the product's own. */}
        <div
          style={{
            display: "flex",
            fontFamily: OG_BODY_FAMILY,
            fontWeight: OG_BODY_WEIGHT,
            fontSize: 28,
            // `--text-secondary`
            color: OG_TOKENS.textSecondary,
          }}
        >
          {host ?? "Free, permanent, dead-simple hosting for one HTML file."}
        </div>
      </div>
    </div>
  );
}
