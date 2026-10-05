/** @jsxRuntime automatic @jsxImportSource react */
/**
 * The OG card's layout — E06 task 010 (D10), redrawn in task 016.
 *
 * The composition is the Page Card thumbnail template from Claude Design
 * (`kept Page Card.dc.html`: `t.bg`, `t.deco`, `t.kicker`, `t.head`, `t.ink`):
 * a full-bleed background, a decoration top right, and a kicker over a large
 * headline anchored bottom left, all in the theme's ink. The background, the
 * ink and the decoration come from the page's theme (`./palette.ts`, picked
 * from its id), so every page has its own look and keeps it across renames.
 * The faces stay kept's bundled ones; a discreet wordmark top left is the brand
 * on a shared link. (Task 010's card was one pale kept-palette frame with the
 * mascot as the decoration; Arun asked for the gradients instead.)
 *
 * (The pragma above is for `tsx --test`, which compiles this file without
 * Next's JSX settings; `card.test.ts` renders the card for real.)
 *
 * Satori resolves no CSS variables, no `@theme`, no Tailwind class and no
 * cascade, so every colour on the card is a literal — and every literal comes
 * from `./palette.ts`, where the rule for them is written down. Nothing here
 * names a colour.
 *
 * ── WHAT THE CARD IS ALLOWED TO SAY ─────────────────────────────────────────
 *
 * The route is unauthenticated by necessity (it is consumed as an `<img>` and by
 * crawlers), so the card renders **only what is already public**: the page's
 * title — which the page serves to the world — or its name, which is its
 * hostname. Plus the brand mark, on a background derived from the id the
 * caller already holds. No owner, no counts, no status, no clock: a countdown
 * baked into an `immutable` response would be wrong within hours and wrong
 * forever, and the studio paints the draft chip over the thumbnail itself, from
 * the live clock.
 */
import { OG_BODY_FAMILY, OG_BODY_WEIGHT, OG_DISPLAY_FAMILY, OG_DISPLAY_WEIGHT } from "./font";
import type { OgTheme } from "./palette";

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
 * 64 px across 880 px a title-case sentence sets ~23 characters a line, so an
 * 80-character title (`PAGE_TITLE_MAX_LENGTH`, the storage cap) fills three
 * lines and is often cut short on the third; three lines is also the most the block
 * holds with the kicker, the wordmark and the orb still clear above it.
 * Clamping by *lines* rather than by characters is what makes an all-capitals
 * or an unbroken title fit too — a character cap that suits average glyphs is
 * three lines too many for `W`.
 */
const OG_HEADLINE_LINES = 3;

/**
 * The content inset. 9 % vertically, as the template has it. Horizontally the
 * studio shows this image in a 16:10 box (`object-cover`), which crops 96 px off
 * each side of a 1200 × 630 card, so the inset is that crop plus 64 px — the
 * template's ~7 % of the 1008 px that survive. (Task 010 had 16 px past the
 * crop, which on the gradient cards read as text pressed against the edge.)
 */
const INSET_X = 96 + 64;
const INSET_Y = 57;

/** What the generic card says in place of a page's name and address. */
const GENERIC_HEADLINE = "A page, kept.";
const GENERIC_KICKER = "Free, permanent, dead-simple hosting for one HTML file.";

/**
 * The decoration's diameter. Top right, inset like the wordmark: its bottom edge
 * (57 + 200) stays above the highest the text block can reach — three headline
 * lines and the kicker, anchored bottom left, top out near y = 320 — so the orb
 * never sits under a word, which is why its colours are outside the palette's
 * contrast rule.
 */
const ORB_SIZE = 200;

export interface OgCardProps {
  /** `ogHeadline(...)`, resolved by the caller. `null` on the generic card. */
  headline: string | null;
  /** `{name}.{servingBaseDomain()}` — the kicker. `null` when there is none to show. */
  host: string | null;
  /** `ogTheme(id)` — the background, the ink and the decoration. */
  theme: OgTheme;
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
 * brand mark, on the theme its id picks, and **no page title** (edge case 17,
 * AC45), so a probe learns nothing from the response's status, headers or
 * shape — see the route for how far that uniformity goes and where it
 * necessarily stops.
 */
export function OgCard({ headline, host, theme }: OgCardProps) {
  return (
    <div
      style={{
        display: "flex",
        position: "relative",
        width: "100%",
        height: "100%",
        // `t.bg`. The colour under the gradient is its last stop, so nothing
        // that fails to paint the image can leave the ink on a mismatched ground.
        backgroundColor: theme.stops[theme.stops.length - 1],
        backgroundImage: theme.image,
        color: theme.ink,
      }}
    >
      {/* Brand mark, top left — discreet: the page is the subject, not kept. */}
      <div
        style={{
          display: "flex",
          position: "absolute",
          left: INSET_X,
          top: INSET_Y,
          fontFamily: OG_DISPLAY_FAMILY,
          fontWeight: OG_DISPLAY_WEIGHT,
          fontSize: 32,
          letterSpacing: "-0.04em",
          lineHeight: 1,
        }}
      >
        kept
      </div>

      {/* `t.deco`: the theme's orb, top right, when it has one. */}
      {theme.orb === null ? null : (
        <div
          style={{
            display: "flex",
            position: "absolute",
            right: INSET_X,
            top: INSET_Y,
            width: ORB_SIZE,
            height: ORB_SIZE,
            borderRadius: ORB_SIZE / 2,
            backgroundImage: theme.orb,
          }}
        />
      )}

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
          }}
        >
          {headline ?? GENERIC_HEADLINE}
        </div>
      </div>
    </div>
  );
}
