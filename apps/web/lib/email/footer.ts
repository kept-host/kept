/**
 * The footer every kept email carries (E06a, PRD §6): the sender's name and the
 * `LEGAL_DOCS` links ("Impressum", "Privacy", "Acceptable use") as ABSOLUTE apex URLs.
 *
 * Pure: the caller passes the `from` it already holds (`resendConfig().from`)
 * and the control-plane origin from configuration (`appOrigin()`) — never a
 * request — and `legalHref` turns that into the apex.
 */
import { LEGAL_DOCS, LEGAL_LABELS, legalHref } from "../legal/links";
import { escapeHtml } from "../utils";

export interface EmailFooter {
  text: string;
  html: string;
}

/** `kept <page@kept.host>` → `kept`; a bare address falls back to the product name. */
function senderName(from: string): string {
  const name = /^\s*"?([^"<]*?)"?\s*</.exec(from)?.[1]?.trim();
  return name ? name : "kept";
}

export function emailFooter({
  from,
  origin,
}: {
  from: string;
  origin: string;
}): EmailFooter {
  const name = senderName(from);
  const links = LEGAL_DOCS.map((doc) => ({
    label: LEGAL_LABELS[doc],
    url: new URL(legalHref(doc, origin), origin).href,
  }));

  return {
    text: `-- \n${name}\n${links.map(({ label, url }) => `${label}: ${url}`).join("\n")}\n`,
    html:
      `<hr><p>${escapeHtml(name)} · ` +
      links
        .map(
          ({ label, url }) =>
            `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`
        )
        .join(" · ") +
      `</p>`,
  };
}
