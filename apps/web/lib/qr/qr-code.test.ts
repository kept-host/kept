/**
 * The QR code is generated locally — asserted, not asserted-in-a-comment.
 *
 * The load-bearing test is the last one: it renders the real component with
 * every network primitive rigged to throw, and then greps the markup for a
 * remote reference. A regression to `<img src="https://api.qrserver.com/…">`
 * fails here rather than in a privacy review after launch.
 */
import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QrCode } from "../../components/kept/qr";
import { QR_QUIET_ZONE_MODULES, qrMatrix, qrPath } from "./qr-code";

// `tsconfig.json` sets `jsx: "preserve"` for Next, so the `tsx` runner falls
// back to the CLASSIC JSX transform and emits bare `React.createElement` calls.
// Next's own compiler uses the automatic runtime and needs no such global; this
// one line is what lets the real component be rendered by `node:test`.
(globalThis as typeof globalThis & { React?: typeof React }).React = React;

const URL_UNDER_TEST = "https://quiet-fox.kept-dev.xyz";

test("qrMatrix encodes to a square matrix with the specified quiet zone", () => {
  const matrix = qrMatrix(URL_UNDER_TEST);

  // Smallest QR symbol is 21 modules; the quiet zone adds four on every side.
  assert.ok(matrix.size >= 21 + 2 * QR_QUIET_ZONE_MODULES);
  assert.equal(matrix.modules.length, matrix.size);
  for (const row of matrix.modules) assert.equal(row.length, matrix.size);

  // The quiet zone is light all the way round, or scanners lose the symbol edge.
  const last = matrix.size - 1;
  for (let i = 0; i < matrix.size; i++) {
    for (let q = 0; q < QR_QUIET_ZONE_MODULES; q++) {
      assert.equal(matrix.modules[q]![i], false);
      assert.equal(matrix.modules[last - q]![i], false);
      assert.equal(matrix.modules[i]![q], false);
      assert.equal(matrix.modules[i]![last - q], false);
    }
  }
});

test("qrMatrix places the three finder patterns", () => {
  const matrix = qrMatrix(URL_UNDER_TEST);
  const z = QR_QUIET_ZONE_MODULES;
  const far = matrix.size - z - 7;

  // A finder is a 7×7 dark ring: dark corner, light one module in, dark centre.
  for (const [ox, oy] of [
    [z, z],
    [far, z],
    [z, far],
  ] as const) {
    assert.equal(matrix.modules[oy]![ox], true, "finder outer ring");
    assert.equal(matrix.modules[oy + 1]![ox + 1], false, "finder light ring");
    assert.equal(matrix.modules[oy + 3]![ox + 3], true, "finder centre");
  }
});

test("qrPath emits one unit square per dark module", () => {
  const matrix = qrMatrix(URL_UNDER_TEST);
  const dark = matrix.modules.flat().filter(Boolean).length;

  assert.equal(qrPath(matrix).split("z").length - 1, dark);
});

test("different values encode to different matrices", () => {
  const a = qrPath(qrMatrix("https://one.kept-dev.xyz"));
  const b = qrPath(qrMatrix("https://two.kept-dev.xyz"));

  assert.notEqual(a, b);
});

test("the rendered QR makes zero outbound network requests", () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    throw new Error("The QR component must not reach the network.");
  }) as typeof fetch;

  try {
    const markup = renderToStaticMarkup(
      QrCode({ value: URL_UNDER_TEST, label: `QR code for ${URL_UNDER_TEST}` }),
    );

    assert.equal(calls, 0);
    // Nothing the browser would resolve: no `src`/`href`, no <img>/<image>, no
    // CSS `url()`. The encoded URL appears exactly once, in the accessible name
    // — as text a screen reader speaks, never as something a browser fetches.
    assert.doesNotMatch(markup, /(?:\bsrc|href)\s*=/);
    assert.doesNotMatch(markup, /<img|<image|url\(/);
    assert.equal(markup.match(/https?:/g)?.length, 1);
    assert.match(markup, /aria-label="QR code for https:\/\//);
    assert.match(markup, /<svg[^>]+role="img"/);
    assert.match(markup, /<path[^>]+d="M/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
