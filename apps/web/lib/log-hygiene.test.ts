/**
 * AC24 guard (E06a): no log line carries an email address, an IP or a token.
 *
 * Scans the SOURCE of every module E06a adds that handles those values and
 * fails on a `console.*` call whose arguments reference an identifier or
 * property named like one (`email`, `ip`, `token`, `adminEmail`, `clientIp`,
 * `confirmToken`, …). String literals are not identifiers, so a message that
 * merely says "token rejected" is fine; `${token}` is not.
 *
 * LATER TASKS EXTEND `GUARDED_FILES` with every module they add under
 * `lib/rate-limit`, `lib/waitlist`, `lib/founding`, `lib/launch`, `lib/email`.
 * A listed file that does not exist fails the test, so the list cannot rot.
 *
 * Pure source analysis: no network, no database; runs everywhere.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import ts from "typescript";

const GUARDED_FILES = [
  "lib/rate-limit/index.ts",
  "lib/rate-limit/client-ip.ts",
  "lib/publish/hooks.ts",
  "lib/launch.ts",
  "lib/launch-access.ts",
  "lib/access-token.ts",
  "lib/waitlist/join.ts",
  "lib/waitlist/confirm.ts",
  "lib/waitlist/unsubscribe.ts",
  "lib/waitlist/client.ts",
  "lib/db/queries/waitlist.ts",
  "lib/email/waitlist.ts",
  "lib/email/list-unsubscribe.ts",
  "app/api/waitlist/route.ts",
  "app/api/waitlist/confirm/route.ts",
  "app/api/waitlist/unsubscribe/route.ts",
  "app/api/cron/waitlist-prune/route.ts",
  "app/(marketing)/waitlist/unsubscribe/page.tsx",
  "lib/auth/closed-sign-in.ts",
  "lib/founding/apply.ts",
  "lib/founding/review.ts",
  "lib/founding/review-token.ts",
  "lib/db/queries/founding.ts",
  "lib/email/founding.ts",
  "app/api/founding/review/route.ts",
  "app/(marketing)/founding/review/page.tsx",
  "lib/admin/cli.ts",
  "scripts/admin.ts",
  // Task 010: every other module E06a added, plus the closed gate's entry points.
  "app/(marketing)/founding/og.png/route.ts",
  "app/(marketing)/founding/page.tsx",
  "app/(marketing)/legal/[doc]/page.tsx",
  "app/(marketing)/og.png/route.ts",
  "app/(marketing)/waitlist/confirm/page.tsx",
  "app/apple-touch-icon.png/route.ts",
  "app/favicon.ico/route.ts",
  "app/icon.svg/route.ts",
  "app/api/publish/route.ts",
  "middleware.ts",
  "components/kept/email-form.tsx",
  "components/kept/founding-form.tsx",
  "components/kept/founding-review.tsx",
  "components/kept/legal-links.tsx",
  "components/kept/turnstile.tsx",
  "components/kept/waitlist-confirm.tsx",
  "lib/auth/cookie.ts",
  "lib/email/footer.ts",
  "lib/legal/index.ts",
  "lib/legal/links.ts",
  "lib/og/brand.tsx",
  "lib/og/preview.ts",
  "scripts/check-resend-tracking.ts",
  "scripts/smoke-release.ts",
  // E07 task 002: the governors' alert path.
  "lib/email/admin-alert.ts",
  "lib/publish/anon-manage.ts",
  "lib/publish/pipeline.ts",
  // E07 task 003: syncManifest and the durable re-purge.
  "lib/storage/manifest.ts",
  "lib/storage/repurge.ts",
  "lib/db/queries/manifest-sync.ts",
  "app/api/cron/repurge/route.ts",
  // E07 task 007: the scan runtime, its queries and the scan-retry job.
  "lib/scan/run.ts",
  "lib/db/queries/scans.ts",
  "app/api/cron/scan-retry/route.ts",
  "app/api/health/route.ts",
  // E07 task 004: the moderation module, its mail and the appeal routes.
  "lib/moderation/status.ts",
  "lib/moderation/appeals.ts",
  "lib/moderation/appeal-http.ts",
  "lib/db/queries/moderation.ts",
  "lib/email/moderation.ts",
  "app/api/sites/[id]/appeal/route.ts",
  "app/api/anon/[anonToken]/appeal/route.ts",
];

/** `email`, `ip`, `token`, or a camelCase name ending in one of them. */
const SENSITIVE_NAME = /^(?:emails?|ips?|tokens?)$|(?:Emails?|Ips?|IPs?|Tokens?)$/;

/** Every sensitive identifier referenced inside a `console.*(...)` call. */
function sensitiveLogReferences(source: string, fileName = "source.ts"): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];

  const collect = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && SENSITIVE_NAME.test(node.text)) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${fileName}:${line + 1} ${node.text}`);
    }
    ts.forEachChild(node, collect);
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "console"
    ) {
      node.arguments.forEach(collect);
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return found;
}

test("the detector flags interpolated identities and ignores plain words", () => {
  assert.deepEqual(sensitiveLogReferences("console.error(`failed for ${email}`);").length, 1);
  assert.deepEqual(sensitiveLogReferences("console.warn('x', body.clientIp);").length, 1);
  assert.deepEqual(sensitiveLogReferences("console.log(`t=${confirmToken}`);").length, 1);
  assert.deepEqual(sensitiveLogReferences("console.info({ ip });").length, 1);
  assert.deepEqual(sensitiveLogReferences("console.error('token rejected for this email');"), []);
  assert.deepEqual(sensitiveLogReferences("console.error(`${err.message}`, relationship, tip);"), []);
  assert.deepEqual(sensitiveLogReferences("logger(email); const t = token;"), []);
});

test("no guarded E06a module logs an email, an IP or a token", () => {
  const root = path.resolve(import.meta.dirname, "..");
  for (const relative of GUARDED_FILES) {
    const absolute = path.join(root, relative);
    assert.ok(existsSync(absolute), `${relative} is listed but missing — update GUARDED_FILES`);
    assert.deepEqual(sensitiveLogReferences(readFileSync(absolute, "utf8"), relative), []);
  }
});
