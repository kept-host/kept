// @kept/edge — the badge's injection into an HTML response (E10 D1–D2).
//
// The markup is NOT built here: `renderBadge` in `@kept/shared` owns it, escapes
// every manifest value itself and hashes the result. This module only decides
// WHERE the finished string goes in a stranger's document and streams it there
// with `HTMLRewriter`, so a page is still never buffered into Worker memory.
//
// Nothing here concatenates a manifest string into HTML.

/** Only HTML documents get a badge; every other type is served byte-identically. */
export function injectsBadge(contentType: string): boolean {
  return contentType.startsWith("text/html");
}

/**
 * Stream `body` with `badgeHtml` appended exactly once: right before the first
 * `</body>` end tag, or — for a document that never closes a `<body>` (no body
 * element, or an implied one) — at the very end of the document, where a parser
 * still places it inside the body.
 *
 * `HTMLRewriter` tokenizes like a browser, so a `</body>` inside a `<script>`
 * string or a comment is not an end tag and never receives the badge.
 *
 * The returned stream has no known length, so the response carries no
 * `Content-Length` — the injected bytes would have made R2's wrong anyway.
 */
export function injectBadge(body: ReadableStream, badgeHtml: string): ReadableStream | null {
  let injected = false;
  return new HTMLRewriter()
    .on("body", {
      element(element) {
        element.onEndTag((endTag) => {
          if (injected) return;
          injected = true;
          endTag.before(badgeHtml, { html: true });
        });
      },
    })
    .onDocument({
      end(end) {
        if (injected) return;
        injected = true;
        end.append(badgeHtml, { html: true });
      },
    })
    .transform(new Response(body)).body;
}
