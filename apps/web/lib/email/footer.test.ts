/** The email footer (E06a, PRD §6, AC18): sender name + absolute apex legal links. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { emailFooter } from "./footer";

test("split deploy: links are absolute on the apex, never the app. host", () => {
  const footer = emailFooter({
    from: "kept <page@kept.host>",
    origin: "https://app.kept.host",
  });
  console.log(`[footer] text=${JSON.stringify(footer.text)}`);
  assert.equal(
    footer.text,
    "-- \nkept\nImpressum: https://kept.host/legal/impressum\nPrivacy: https://kept.host/legal/privacy\nAcceptable use: https://kept.host/legal/acceptable-use\n"
  );
  assert.equal(
    footer.html,
    '<hr><p>kept · <a href="https://kept.host/legal/impressum">Impressum</a> · ' +
      '<a href="https://kept.host/legal/privacy">Privacy</a> · ' +
      '<a href="https://kept.host/legal/acceptable-use">Acceptable use</a></p>'
  );
  assert.doesNotMatch(`${footer.text}${footer.html}`, /app\.kept\.host/);
});

test("single-origin deploy: links are absolute on that origin", () => {
  const { text } = emailFooter({
    from: "kept <page@kept.host>",
    origin: "https://localhost:3000",
  });
  assert.match(
    text,
    /^Impressum: https:\/\/localhost:3000\/legal\/impressum$/m
  );
  assert.match(text, /^Privacy: https:\/\/localhost:3000\/legal\/privacy$/m);
});

test("sender name: display name when present, escaped in HTML; bare address falls back to kept", () => {
  assert.match(
    emailFooter({ from: "page@kept.host", origin: "https://app.kept.host" })
      .text,
    /^-- \nkept\n/
  );
  const quoted = emailFooter({
    from: '"K & co" <page@kept.host>',
    origin: "https://app.kept.host",
  });
  assert.match(quoted.text, /^-- \nK & co\n/);
  assert.match(quoted.html, /<p>K &amp; co · /);
});
