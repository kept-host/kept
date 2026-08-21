/**
 * The page's human name: `<title>` out of the HTML, into `sites.title`.
 * E06 task 001, migration `0004`.
 *
 * WHY A COLUMN AND NOT A READ. The dashboard's entire job is finding your own
 * page, and a wall of `k3n8vq2p` / `9wtx4mbd` / `p7fz2h6r` cannot do that.
 * Deriving the name per card would put an R2 round trip into the dashboard's
 * critical path for a value that only changes when the bytes change, so it is
 * cached in Postgres — and the invalidation point is precise: the FOUR paths
 * that write bytes. A title populated on publish but not on replace is strictly
 * worse than no title, because the wall then confidently displays the PREVIOUS
 * page's name. Every writer calls this function.
 *
 * ⚠️ THE INPUT IS UNTRUSTED, STRANGER-AUTHORED HTML. The result is rendered
 * into a dashboard card and painted into an OG image, so it is trimmed,
 * collapsed, entity-decoded for the common set and capped here — once, at the
 * write — rather than defensively at each of the two consumers.
 *
 * ⚠️ IT NEVER THROWS. An unreadable title is a page with no title, not a failed
 * publish. Every branch below either returns a string or returns `null`; there
 * is no input — malformed, unclosed, adversarial or 256 KB of garbage — for
 * which the correct behaviour is to fail the caller's publish.
 *
 * IT IS NOT A PARSER AND MUST NOT BECOME ONE. One anchored regex over the head
 * of the document, no dependency, in any workspace. If a page's title only
 * comes out of a real DOM, that page renders as its slug and everyone survives.
 */

/**
 * The stored length cap, in code points.
 *
 * Chosen ABOVE what either consumer can display, so the cap never clips a title
 * a human would have seen — it exists to bound pathological input, while the
 * card and the OG image do their own visual truncation:
 *
 *   - OG card (task 010): 1200×630 with ~1040px of content width. A headline in
 *     the display face at ~56px averages ~28px per glyph, so ~37 characters per
 *     line and ~3 lines before the card stops being a card — ≈111 characters.
 *   - Dashboard card (task 003): ~360px wide at the body size, ~45 characters
 *     per line, clamped to two lines — ≈90 characters.
 *
 * 120 sits just past the larger of the two. Anything longer is invisible on
 * both surfaces by construction, so storing it would only widen the row and
 * hand the renderers a string they have to defend against anyway.
 *
 * ⚠️ This is a STORAGE cap, not a display rule. Consumers still clamp; they must
 * not assume a title is short enough to fit.
 */
export const PAGE_TITLE_MAX_CHARS = 120;

/**
 * Only the head of the document is searched. A `<title>` 200 KB into a body is
 * not the document's title, and scanning megabytes of user bytes with a regex
 * on the publish path is a cost with no upside. Comfortably past any real
 * `<head>`, including inlined critical CSS.
 */
const HEAD_SCAN_BYTES = 64 * 1024;

/**
 * `<title …>` … `</title>`, case-insensitive, attributes allowed, newlines
 * inside the content allowed (`[\s\S]`). Non-greedy so the FIRST title wins —
 * a second one is invalid HTML and browsers ignore it too.
 *
 * `[^>]*` after the tag name is what lets `<title data-x="y">` match while
 * `<titlebar>` does not: the character after `title` must be `>` or the start
 * of an attribute, never another name character.
 */
const TITLE_RE = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i;

/** `<!-- … -->`, non-greedy. Stripped before the title search — see below. */
const COMMENT_RE = /<!--[\s\S]*?-->/g;

/** `<script …>…</script>` and the same for `<style>`, contents included. */
const RAW_TEXT_RE = /<(script|style)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi;

/**
 * The entities a hand-written or generated `<title>` actually contains. Not a
 * table of all 2231 HTML named references — that is the parser this file
 * refuses to become. Anything outside this set is left LITERAL, which renders
 * as the author typed it and is always safe.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** `&name;` or `&#123;` / `&#x1F600;`. */
const ENTITY_RE = /&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g;

function decodeEntities(input: string): string {
  return input.replace(ENTITY_RE, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // Reject NaN, the null character, lone surrogates and anything past the
      // Unicode range. `String.fromCodePoint` THROWS on those, and this
      // function's whole contract is that it does not.
      if (
        !Number.isInteger(code) ||
        code <= 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        return whole;
      }
      return String.fromCodePoint(code);
    }
    // Unknown names stay literal rather than becoming a mystery character.
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Extract a page's display name from its HTML.
 *
 * @returns the cleaned title, or `null` when the document has no usable one —
 *   absent tag, empty tag, whitespace-only content, or unparseable input.
 *   NEVER `""`, because `title ?? slug` would then render an empty card.
 */
export function extractPageTitle(html: string): string | null {
  if (typeof html !== "string" || html.length === 0) return null;

  // Comments and raw-text elements are removed FIRST so `<!-- <title>x</title> -->`
  // and a `<title>` inside a `<script>` template both correctly find nothing,
  // rather than the regex happily matching text no browser would ever render.
  const head = html
    .slice(0, HEAD_SCAN_BYTES)
    .replace(COMMENT_RE, " ")
    .replace(RAW_TEXT_RE, " ");

  const match = TITLE_RE.exec(head);
  // No match also covers an UNCLOSED `<title>`: with no `</title>` there is no
  // way to know where the title ends, and guessing "to the end of the document"
  // would store the whole page as a name.
  if (!match) return null;

  // The capture group always participates when the pattern matches; `?? ""`
  // only satisfies `noUncheckedIndexedAccess` and folds to the `null` below.
  const collapsed = decodeEntities(match[1] ?? "").replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;

  return truncate(collapsed);
}

/**
 * Cap at `PAGE_TITLE_MAX_CHARS`, counting CODE POINTS rather than UTF-16 units,
 * so a title of emoji or astral-plane characters is never cut through the
 * middle of a surrogate pair into a replacement character. `Array.from` splits
 * on code points, which is the closest cheap approximation of "a character
 * boundary" without pulling in a grapheme segmenter.
 */
function truncate(value: string): string {
  const points = Array.from(value);
  if (points.length <= PAGE_TITLE_MAX_CHARS) return value;
  return points.slice(0, PAGE_TITLE_MAX_CHARS).join("").trimEnd();
}
