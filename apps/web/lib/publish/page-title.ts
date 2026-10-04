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
 * ⚠️ AN OWNER'S TITLE WINS (D11). This function only says what the HTML calls
 * the page; whether that is stored is the write's decision. A row with
 * `title_source = 'owner'` keeps its title through every replace — that guard
 * lives in the SQL (`lib/db/queries/publish.ts`), so a concurrent title edit
 * cannot be lost between a read and a write.
 *
 * ⚠️ THE INPUT IS UNTRUSTED, STRANGER-AUTHORED HTML. The result is rendered
 * into a dashboard card and painted into an OG image, so it is entity-decoded
 * for the common set, tag-stripped, whitespace-collapsed and capped at
 * `PAGE_TITLE_MAX_LENGTH` here — once, at the write — rather than defensively at
 * each of the two consumers.
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

import { PAGE_TITLE_MAX_LENGTH } from "@kept/shared";

/**
 * Only the head of the document is searched — the first 64 KB of its UTF-8
 * bytes (D11, PRD §5.9). A `<title>` 200 KB into a body is not the document's
 * title, and scanning megabytes of user bytes with a regex on the publish path
 * is a cost with no upside. Comfortably past any real `<head>`, including
 * inlined critical CSS.
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
 * An opening or closing tag inside the title text — `<b>`, `</em>`, `<br/>`.
 * A letter must follow the `<` (or `</`), so `a < b` and `I <3 kept` are text,
 * not tags. Replaced with a space, never with nothing, so `Hello<br>World`
 * cannot glue two words into one; the whitespace collapse folds the extra.
 */
const TAG_RE = /<\/?[A-Za-z][^>]*>/g;

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
  const head = headOf(html).replace(COMMENT_RE, " ").replace(RAW_TEXT_RE, " ");

  const match = TITLE_RE.exec(head);
  // No match also covers an UNCLOSED `<title>`: with no `</title>` there is no
  // way to know where the title ends, and guessing "to the end of the document"
  // would store the whole page as a name.
  if (!match) return null;

  // Decode, THEN strip tags, then collapse — the PRD's order. Decoding first is
  // what makes an entity-encoded tag (`&lt;b&gt;`) a tag that gets stripped,
  // rather than markup that survives into a card and an image. The capture
  // group always participates when the pattern matches; `?? ""` only satisfies
  // `noUncheckedIndexedAccess` and folds to the `null` below.
  const collapsed = decodeEntities(match[1] ?? "")
    .replace(TAG_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length === 0) return null;

  return truncate(collapsed);
}

/**
 * The first `HEAD_SCAN_BYTES` bytes of the document, as text.
 *
 * Sliced by code units first — never more than three bytes each, so that slice
 * always holds the whole byte window — and only that slice is encoded, so a
 * 5 MB page costs one bounded copy, not two full ones. A multi-byte character
 * cut at the window's edge decodes to U+FFFD at the very end, past anything a
 * `<title>` inside the window could contain.
 */
function headOf(html: string): string {
  const bytes = new TextEncoder().encode(html.slice(0, HEAD_SCAN_BYTES));
  return new TextDecoder().decode(bytes.subarray(0, HEAD_SCAN_BYTES));
}

/**
 * Cap at `PAGE_TITLE_MAX_LENGTH`, counting CODE POINTS rather than UTF-16
 * units, so a title of emoji or astral-plane characters is never cut through
 * the middle of a surrogate pair into a replacement character. `Array.from`
 * splits on code points, which is the closest cheap approximation of "a
 * character boundary" without pulling in a grapheme segmenter.
 */
function truncate(value: string): string {
  const points = Array.from(value);
  if (points.length <= PAGE_TITLE_MAX_LENGTH) return value;
  return points.slice(0, PAGE_TITLE_MAX_LENGTH).join("").trimEnd();
}
