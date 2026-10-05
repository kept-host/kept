/**
 * The thumbnail palette — E06 task 016.
 *
 * Every page's card is drawn on one of these gradients, picked from its id, so a
 * wall of pages reads as a wall of different things rather than twenty copies of
 * one card. The themes are the Page Card design's sample thumbnails
 * (`design/kept-pages.js`, `t.bg` / `t.ink`, plus the colours of their `t.deco`)
 * turned into gradients: the night-sky navy of "Orbital Ship", the tide-table
 * teal, the miso-ramen cream, the voxel forest, and so on. Their display fonts
 * are NOT carried over — the card keeps its bundled faces (`./font.ts`).
 *
 * ── WHY THERE ARE COLOUR LITERALS HERE, AND WHY THAT IS NOT A TOKEN BREACH ───
 *
 * Tokens are kept's own interface colours. These are not: they are per-page
 * artwork, the same category as the pixels of the page itself, and kept's UI
 * never paints itself with them. They are needed in exactly two places, from
 * this one module:
 *
 *   · the Satori card (`./card.tsx`), which cannot read CSS variables at all;
 *   · the studio's `SiteCard`, which paints the same gradient under the PNG as
 *     inline style data, so a card is never blank while the image loads or if
 *     it fails. No component writes a colour; it hands over `theme.image`.
 *
 * ── THE RULES EVERY ENTRY KEEPS (asserted in `palette.test.ts`) ──────────────
 *
 *   · `ink` reaches 4.5:1 (WCAG AA, normal text) against EVERY stop of the
 *     background, so the kicker and the headline are legible wherever the
 *     gradient happens to sit under them — and wherever a 16:10 crop cuts it.
 *   · The orb is decoration only. It sits top right, above anything the text
 *     block can reach (the headline is clamped to three lines, anchored bottom
 *     left), so its colours are free and not part of the contrast rule.
 *   · Only gradient syntax Satori renders: `linear-gradient(<angle>deg, …)` and
 *     `radial-gradient(circle at <x> <y>, …)`, stops as six-digit hex.
 *
 * ── THE PICK IS THE ID, NOT THE NAME ─────────────────────────────────────────
 *
 * `ogTheme(siteId)` hashes the page's id, which never changes, so a rename keeps
 * the look — the gradient is the page's, from the moment it was first
 * published. The OG route hashes whatever id it was asked for, real or not, so
 * an unknown id gets a theme exactly the way a real one does and the response
 * says nothing about which it was (see `app/api/og/[siteId]/route.tsx`).
 *
 * JSX-free and dependency-free on purpose: the studio's client bundle imports it.
 */

export interface OgTheme {
  /** For the test report and for reading this file. Never rendered. */
  name: string;
  /** The text colour — kicker, headline, wordmark. */
  ink: string;
  /** The background's colour stops, first to last. */
  stops: readonly string[];
  /** `background-image`: the gradient over `stops`. */
  image: string;
  /** `background-image` of the decorative orb, or `null` for a theme without one. */
  orb: string | null;
}

/** How a theme's background runs: a linear angle, or a radial centre. */
type Shape = { linear: number } | { radialAt: string };

function gradient(shape: Shape, stops: readonly string[]): string {
  const last = stops.length - 1;
  const list = stops.map((stop, i) => `${stop} ${Math.round((i / last) * 100)}%`).join(", ");
  return "linear" in shape
    ? `linear-gradient(${shape.linear}deg, ${list})`
    : `radial-gradient(circle at ${shape.radialAt}, ${list})`;
}

/** An orb lit from its upper left, as the design's planets and moons are. */
function orb(stops: readonly string[]): string {
  return gradient({ radialAt: "35% 30%" }, stops);
}

function theme(
  name: string,
  ink: string,
  shape: Shape,
  stops: readonly string[],
  orbStops: readonly string[] | null = null,
): OgTheme {
  return { name, ink, stops, image: gradient(shape, stops), orb: orbStops && orb(orbStops) };
}

/**
 * The palette. ⚠️ Any change to this list — a colour, the order, the length —
 * repaints existing pages (the pick is `hash % length`), while their cards sit
 * in year-long `immutable` caches. So it ships with a bump of
 * `OG_TEMPLATE_VERSION` (`./card-url.ts`), or the cached PNG and the studio's
 * CSS gradient under it disagree.
 */
export const OG_PALETTE: readonly OgTheme[] = [
  theme("orbital", "#E8ECFF", { radialAt: "75% 20%" }, ["#33437A", "#121A3A", "#070A18"], ["#C8D4FF", "#4B5FB8", "#1A2350"]),
  theme("habit", "#1B1B1B", { linear: 160 }, ["#FFFFFF", "#D7EFC2"]),
  theme("solar", "#FFE8B0", { radialAt: "85% 10%" }, ["#3A2410", "#14100C", "#05060A"], ["#FFE8B0", "#FFB347", "#B8561E"]),
  theme("launch", "#FFFFFF", { linear: 135 }, ["#CC3D1F", "#A82A15"]),
  theme("synth", "#FF6EC7", { linear: 180 }, ["#2A2240", "#16131F"]),
  theme("harbor", "#FFF1E8", { linear: 160 }, ["#2B3D73", "#1D2B53"]),
  theme("mars", "#FFD8C2", { radialAt: "85% 0%" }, ["#7A2E1A", "#2A120C"], ["#E07A4F", "#A9452A", "#7A2E1A"]),
  theme("miso", "#3B2414", { linear: 160 }, ["#F4E9D8", "#E8CFAE"], ["#F2C14E", "#EADBC2", "#C8553D"]),
  theme("snake", "#39FF88", { linear: 200 }, ["#14202A", "#0B0B12"]),
  theme("pulse", "#E6EDF3", { linear: 180 }, ["#3D2B12", "#0E1116"]),
  theme("typing", "#E8FF59", { linear: 135 }, ["#22221A", "#111111"]),
  theme("lunar", "#E9E4FF", { radialAt: "80% 15%" }, ["#2E2950", "#14121F"], ["#F4F1FF", "#E9E4FF", "#B9AEE8"]),
  theme("flight", "#BFE3FF", { linear: 180 }, ["#1B3D5C", "#0F2233"]),
  theme("tide", "#0F3A40", { linear: 180 }, ["#DDF0F1", "#A9D6DB"]),
  theme("garden", "#23361E", { linear: 170 }, ["#EEF5E9", "#CFE2C2"]),
  theme("nori", "#111111", { linear: 135 }, ["#ECE9E3", "#D8D2C6"]),
  theme("reading", "#2B2B2B", { linear: 160 }, ["#FDF6E3", "#F2DDB0"]),
  theme("chamber", "#D6F5FF", { radialAt: "20% 0%" }, ["#16222E", "#0A0D12"]),
  theme("chess", "#1A1714", { linear: 150 }, ["#EEEED2", "#C9D6A3"]),
  theme("rain", "#E3ECF5", { linear: 180 }, ["#3B4A5C", "#1E2733"]),
  theme("budget", "#1A1714", { linear: 135 }, ["#FFFDF7", "#E6DFFF"]),
  theme("wave", "#C9B8FF", { radialAt: "80% 10%" }, ["#241A40", "#120C1F"]),
  theme("forest", "#123620", { linear: 180 }, ["#CFE6D4", "#7FB08A"]),
];

/**
 * A stable 32-bit hash of an id (FNV-1a over its UTF-16 code units).
 *
 * Lower-cased first: a UUID is case-insensitive, so `ABC…` and `abc…` are the
 * same page and must be the same theme.
 */
function idHash(id: string): number {
  const text = id.toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The palette index a page's id maps to. */
export function ogThemeIndex(siteId: string): number {
  return idHash(siteId) % OG_PALETTE.length;
}

/** A page's theme — the same for the life of the page, whatever it is called. */
export function ogTheme(siteId: string): OgTheme {
  return OG_PALETTE[ogThemeIndex(siteId)]!;
}
