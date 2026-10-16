/**
 * The moderation screen's pure rules (E07 task 011, AC21, §9): which reason
 * each action requires, the Source cap, the Scanner light.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ADMIN_SOURCE_PREVIEW_BYTES } from "@kept/shared";

import {
  adminPageUrl,
  appealDecisionSchema,
  dismissReportsSchema,
  isShown,
  scannerLight,
  siteActionSchema,
  sourcePreview,
} from "./admin-rules";

test("AC21: every action requires a reason — a listed one to restrict, a written one otherwise", () => {
  assert.ok(siteActionSchema.safeParse({ action: "hide", reason: "phishing" }).success);
  assert.ok(siteActionSchema.safeParse({ action: "remove", reason: "spam", note: "" }).success);
  assert.ok(!siteActionSchema.safeParse({ action: "hide" }).success, "hide without a reason");
  assert.ok(!siteActionSchema.safeParse({ action: "remove", reason: "nonsense" }).success, "an unlisted reason");
  assert.ok(!siteActionSchema.safeParse({ action: "restore" }).success, "restore without a written reason");
  assert.ok(!siteActionSchema.safeParse({ action: "restore", note: "   " }).success, "a blank one");
  assert.ok(siteActionSchema.safeParse({ action: "restore", note: "checked" }).success);
  assert.ok(!siteActionSchema.safeParse({ action: "delete", reason: "spam" }).success, "no such action");

  const id = crypto.randomUUID();
  assert.ok(!dismissReportsSchema.safeParse({ reportIds: [id] }).success);
  assert.ok(!dismissReportsSchema.safeParse({ reportIds: [], note: "x" }).success);
  assert.ok(dismissReportsSchema.safeParse({ reportIds: [id], note: "x" }).success);
  assert.ok(!appealDecisionSchema.safeParse({ decision: "grant" }).success);
  assert.ok(appealDecisionSchema.safeParse({ decision: "reject", note: "stands" }).success);

  // An optional note left empty is no note; a written one is trimmed.
  const hide = siteActionSchema.parse({ action: "hide", reason: "phishing", note: "" });
  assert.equal("note" in hide ? hide.note : undefined, undefined);
  assert.equal(siteActionSchema.parse({ action: "restore", note: "  ok  " }).note, "ok");
});

test("Source shows at most ADMIN_SOURCE_PREVIEW_BYTES, counted in bytes", () => {
  assert.deepEqual(sourcePreview("<h1>hi</h1>"), { text: "<h1>hi</h1>", truncated: false });
  const big = "é".repeat(ADMIN_SOURCE_PREVIEW_BYTES); // 2 bytes each
  const preview = sourcePreview(big);
  assert.equal(preview.truncated, true);
  assert.ok(new TextEncoder().encode(preview.text).length <= ADMIN_SOURCE_PREVIEW_BYTES);
  assert.equal(preview.text.length, ADMIN_SOURCE_PREVIEW_BYTES / 2);
});

test("§9: the Scanner light", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  assert.equal(scannerLight({ keyPresent: true, lastSuccessAt: ago(0.5), now }), "green");
  assert.equal(scannerLight({ keyPresent: true, lastSuccessAt: ago(2), now }), "amber");
  assert.equal(scannerLight({ keyPresent: true, lastSuccessAt: ago(7), now }), "amber");
  assert.equal(scannerLight({ keyPresent: true, lastSuccessAt: ago(25), now }), "red");
  assert.equal(scannerLight({ keyPresent: true, lastSuccessAt: null, now }), "red");
  assert.equal(scannerLight({ keyPresent: false, lastSuccessAt: ago(0.1), now }), "red");
});

test("D13 + D-69: the byte URLs carry the Show intent only when asked, and only ?show=1 counts", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  assert.equal(adminPageUrl(id, "preview"), `/api/admin/moderation/sites/${id}/preview`);
  assert.equal(adminPageUrl(id, "source", true), `/api/admin/moderation/sites/${id}/source?show=1`);
  const base = "https://app.kept-test.example";
  assert.ok(isShown(new URL(adminPageUrl(id, "preview", true), base)));
  assert.ok(!isShown(new URL(adminPageUrl(id, "preview"), base)));
  for (const query of ["?show=true", "?show=", "?show", "?Show=1"]) {
    assert.ok(!isShown(new URL(`${adminPageUrl(id, "preview")}${query}`, base)), query);
  }
});
