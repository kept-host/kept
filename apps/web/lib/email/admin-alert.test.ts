/**
 * `sendAdminAlert` (E07 task 002): the one operator-mail helper.
 *
 * The builder is pure and runs everywhere. The throttle drill runs against the
 * real dev Neon branch (skips without `DATABASE_URL`) and never mails anyone:
 * it spends its test-scoped throttle bucket first, so the call under test is
 * the second in the window — exactly the call a flood makes.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { PUBLISH_RATE_LIMITS } from "@kept/shared";
import { config } from "dotenv";

import { adminAlertBucket, buildAdminAlertEmail } from "./admin-alert";

config({ path: ".env.local", quiet: true });

const skipDb = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const throttleKey = `e07-002-alert-${crypto.randomUUID()}`;

after(async () => {
  if (skipDb) return;
  const { eq } = await import("drizzle-orm");
  const { db, closeDb } = await import("../db");
  const { rateLimits } = await import("../db/schema");
  await db.delete(rateLimits).where(eq(rateLimits.bucket, adminAlertBucket(throttleKey)));
  await closeDb();
});

test("the alert is prefixed, one paragraph per line, with the legal footer", () => {
  const email = buildAdminAlertEmail({
    subject: "anonymous publishing reached the global cap",
    lines: ["publish:global reached 1000.", "Signed-in publishing is not limited."],
    from: "kept <page@kept.host>",
    origin: "https://app.kept.host",
  });
  console.log(`[admin-alert] ${JSON.stringify(email)}`);
  assert.equal(email.subject, "[kept alert] anonymous publishing reached the global cap");
  assert.ok(
    email.text.startsWith("publish:global reached 1000.\n\nSigned-in publishing is not limited.\n\n-- \nkept\n"),
  );
  assert.match(email.text, /Impressum: https:\/\/kept\.host\/legal\/impressum/);
});

test("the throttle bucket is namespaced apart from every route's", () => {
  assert.equal(adminAlertBucket("publish:global"), "admin-alert:publish:global");
});

test("a second alert on the same key within the hour is throttled, not sent", { skip: skipDb }, async () => {
  const { hit } = await import("../rate-limit");
  const { sendAdminAlert } = await import("./admin-alert");
  const rule = PUBLISH_RATE_LIMITS.globalCapAlertHour;

  // The first alert of the window, already out.
  assert.deepEqual(await hit(adminAlertBucket(throttleKey), rule), { allowed: true });

  const outcome = await sendAdminAlert({
    subject: "e07-002 throttle drill",
    lines: ["This must never be delivered."],
    throttleKey,
    throttle: rule,
  });
  assert.equal(outcome, "throttled");
});
