/**
 * Comment-aware source scanning, for the two guards that assert over source
 * TEXT rather than behaviour (`lib/routing/configured-origins.test.ts` and
 * `lib/auth/harness-https.test.ts`).
 *
 * Both guards ban a literal from a set of files, and both must not fire on a
 * comment that merely *names* the banned value — the block comments in
 * `middleware.ts`, `host-split.ts` and `playwright.config.ts` explain the rules
 * by quoting the exact hostnames and schemes involved, which is the whole point
 * of those comments and must stay possible. So the guards scan code with the
 * comments removed, and this is the one place that removes them.
 *
 * Test-only: nothing in the app imports it, and its name keeps it outside the
 * unit-test glob in `apps/web/package.json`, so it is never run as a suite of
 * its own. Its own honesty is asserted in
 * `lib/routing/configured-origins.test.ts`.
 *
 * NOT A PARSER, and deliberately not: it tracks string, template and comment
 * state character by character, which is enough for these files, but it does
 * NOT recognise a regex literal — `/\/\//` would read as a line comment and
 * swallow the rest of that line. That is a way for a guard to go quietly
 * vacuous, so every caller re-asserts that known code anchors survive the
 * strip. If a subject file ever grows a regex literal, that assertion is what
 * fails, loudly, instead of the ban silently weakening.
 *
 * Newlines are preserved (blanked, not deleted) so a violation's line number in
 * the stripped text is its line number in the file.
 */

export function stripComments(source: string): string {
  let out = "";
  let i = 0;

  while (i < source.length) {
    const char = source[i]!;
    const next = source[i + 1];

    // `// …` — drop to end of line, leaving the newline for the outer loop.
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }

    // `/* … */` — drop, keeping the newlines it spans.
    if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }

    // A string or template: copied verbatim, so `"https://…"` survives intact.
    if (char === '"' || char === "'" || char === "`") {
      out += char;
      i += 1;
      while (i < source.length) {
        const inner = source[i]!;
        out += inner;
        i += 1;
        if (inner === "\\") {
          if (i < source.length) {
            out += source[i];
            i += 1;
          }
          continue;
        }
        if (inner === char) break;
      }
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
}

/** Every 1-indexed line of `source` that contains `needle`, case-insensitively. */
export function linesContaining(source: string, needle: string): number[] {
  const lower = needle.toLowerCase();
  return source
    .split("\n")
    .map((line, index) => (line.toLowerCase().includes(lower) ? index + 1 : 0))
    .filter((line) => line > 0);
}
