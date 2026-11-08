/**
 * A page's README, markdown → HTML (E10 D6, PRD §5.3, AC10) — the body of the
 * static `/_kept/readme` page `./page.ts` writes to R2.
 *
 * ⚠️ UNTRUSTED STRANGER-AUTHORED TEXT, served on kept's own CSP
 * (`default-src 'none'`, inline styles only). So the renderer is strict:
 *
 *   · `html: false` — raw HTML in the markdown comes out as escaped text.
 *   · no images — the `image` rule is off, so `![alt](url)` renders as `!`
 *     and a link to `url`; the CSP would block the `<img>` anyway.
 *   · links only to `http:`, `https:` and `mailto:` (`validateLink`); any
 *     other target — `javascript:`, `data:`, a relative path — stays text.
 *   · every link carries `rel="nofollow ugc noopener"`.
 *   · no linkify, no typographer: what the author typed is what renders.
 *
 * Pure. The input is held to `PROVENANCE_LIMITS.readme` code points again here,
 * whatever the caller already checked.
 */
import { PROVENANCE_LIMITS } from "@kept/shared";
import MarkdownIt from "markdown-it";

/** The schemes a README link may point at. */
const LINK_SCHEMES = /^(https?:|mailto:)/i;

const LINK_REL = "nofollow ugc noopener";

const md = new MarkdownIt("default", { html: false, linkify: false, typographer: false });
md.disable("image");
md.validateLink = (url) => LINK_SCHEMES.test(url.trim());

const renderToken = md.renderer.renderToken.bind(md.renderer);
md.renderer.rules.link_open = (tokens, idx, options) => {
  tokens[idx]!.attrSet("rel", LINK_REL);
  return renderToken(tokens, idx, options);
};

/** The README's HTML fragment — never a document, never a `<script>` or `<img>`. */
export function renderReadme(markdown: string): string {
  const points = Array.from(markdown);
  const capped = points.length > PROVENANCE_LIMITS.readme ? points.slice(0, PROVENANCE_LIMITS.readme).join("") : markdown;
  return md.render(capped);
}
