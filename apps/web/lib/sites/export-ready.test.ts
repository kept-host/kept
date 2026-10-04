/**
 * The export's start signal — E06 task 013 (`lib/sites/export-ready.ts`).
 *
 * The settings button ends "Preparing…" on exactly one answer: a cookie naming
 * ITS token. So the cases that matter are the ones that would end it wrongly —
 * another attempt's cookie, a value that only starts with the token, a cookie
 * whose name merely contains ours — and the request-side guard that keeps
 * anything but a UUID out of a cookie value.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXPORT_READY_COOKIE,
  exportReadyToken,
  exportReadyValue,
  readExportStart,
} from "./export-ready";

const TOKEN = "3f1c9b5e-2a47-4d8e-9c1a-7b2e6f0d4a11";
const OTHER = "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d";

test("exportReadyToken: a UUID passes; anything that is not one is no token at all", () => {
  assert.equal(exportReadyToken(TOKEN), TOKEN);
  for (const value of [null, "", "abc", `${TOKEN};x=1`, `${TOKEN}.started`, "../../etc", TOKEN.toUpperCase()]) {
    assert.equal(exportReadyToken(value), null, `${JSON.stringify(value)} must not become a cookie value`);
  }
});

test("readExportStart: the route's answer for this token, among other cookies", () => {
  const jar = (value: string) => `theme=light; ${EXPORT_READY_COOKIE}=${value}; other=1`;
  assert.equal(readExportStart(jar(exportReadyValue(TOKEN, "started")), TOKEN), "started");
  assert.equal(readExportStart(jar(exportReadyValue(TOKEN, "failed")), TOKEN), "failed");
  assert.equal(readExportStart(`${EXPORT_READY_COOKIE}=${exportReadyValue(TOKEN, "started")}`, TOKEN), "started");
});

test("readExportStart: nothing yet — no cookie, another attempt's, a look-alike name or value", () => {
  assert.equal(readExportStart("", TOKEN), null);
  assert.equal(readExportStart("theme=light", TOKEN), null);
  assert.equal(
    readExportStart(`${EXPORT_READY_COOKIE}=${exportReadyValue(OTHER, "started")}`, TOKEN),
    null,
    "an earlier attempt's answer must not end this one",
  );
  assert.equal(readExportStart(`x-${EXPORT_READY_COOKIE}=${exportReadyValue(TOKEN, "started")}`, TOKEN), null);
  assert.equal(readExportStart(`${EXPORT_READY_COOKIE}=${TOKEN}`, TOKEN), null);
  assert.equal(readExportStart(`${EXPORT_READY_COOKIE}=${exportReadyValue(TOKEN, "started")}x`, TOKEN), null);
});
