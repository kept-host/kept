/**
 * Referrals (E10 task 009: D11, Q3, Q20, AC17, AC18) against the REAL dev
 * stack — no mocks. Real `auth` instance, real `/api/auth/magic-link/verify`,
 * real `databaseHooks.user.create.after`, real `referrals` rows on the dev Neon
 * branch. Only the email transport is skipped, as in `../auth/bootstrap-profile.test.ts`:
 * the verification value is written through the plugin's own storage contract.
 *
 * Q20 is proved here: the hook sees the `ref` the sign-up's callback URL
 * carried, so no "first app request" fallback exists.
 *
 * No KV, no R2. SKIPS without `DATABASE_URL`.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { config } from "dotenv";

import { parseRef, refFromPath, withRef } from "./ref";

config({ path: ".env.local", quiet: true });

// Sign-ups happen on an OPEN deploy only (E06a: closed is admin-only).
process.env.NEXT_PUBLIC_KEPT_OPEN = "true";

const skipLive = process.env.DATABASE_URL ? false : "DATABASE_URL absent — run locally with apps/web/.env.local";

// Fill only what is missing, as the sibling auth drills do: nothing below
// reaches OAuth or Resend, but constructing the auth instance validates them.
for (const [name, value] of Object.entries({
  BETTER_AUTH_SECRET: "referrals-drill-secret-not-used-for-anything-real",
  BETTER_AUTH_URL: "http://localhost:3000",
  GITHUB_CLIENT_ID: "unprovisioned.github.invalid",
  GITHUB_CLIENT_SECRET: "unprovisioned.github.invalid",
  GOOGLE_CLIENT_ID: "unprovisioned.google.invalid",
  GOOGLE_CLIENT_SECRET: "unprovisioned.google.invalid",
  RESEND_API_KEY: "unprovisioned.resend.invalid",
  EMAIL_FROM: "drill@unprovisioned.invalid",
})) {
  if (!process.env[name]?.trim()) process.env[name] = value;
}

const baseUrl = (process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL)!.replace(/\/+$/, "");

let drill: import("../testing/names-drill").NamesDrill | null = null;
const signedUp: string[] = [];

async function names() {
  const { NamesDrill } = await import("../testing/names-drill");
  drill ??= new NamesDrill("e10-009-r");
  return drill;
}

after(async () => {
  if (skipLive) return;
  const { db, schema } = await import("../db");
  const { inArray } = await import("drizzle-orm");
  // Cascades `profiles` and `referrals`.
  if (signedUp.length) await db.delete(schema.user).where(inArray(schema.user.id, signedUp));
  await drill?.cleanup();
  await db.$client.end();
});

/** A brand-new account, signed up by magic link with `callbackURL` — the path the sign-in form sends. */
async function signUp(callbackURL: string): Promise<string> {
  const { auth } = await import("../auth");
  const { db, schema } = await import("../db");
  const { eq } = await import("drizzle-orm");
  const email = `ref-${crypto.randomUUID().slice(0, 8)}@kept-e10-009.invalid`;
  const token = crypto.randomUUID().replace(/-/g, "");
  await (await auth.$context).internalAdapter.createVerificationValue({
    identifier: token,
    value: JSON.stringify({ email }),
    expiresAt: new Date(Date.now() + 300_000),
  });
  // Exactly the URL the email would carry: `callbackURL` encoded once.
  const url = new URL(`${baseUrl}/api/auth/magic-link/verify`);
  url.searchParams.set("token", token);
  url.searchParams.set("callbackURL", callbackURL);
  const verified = await auth.handler(new Request(url));
  assert.equal(verified.status, 302, await verified.clone().text());
  assert.equal(new URL(verified.headers.get("location")!, baseUrl).pathname, "/dashboard");
  const [row] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email));
  assert.ok(row, "the sign-up made a user");
  signedUp.push(row.id);
  return row.id;
}

async function referralOf(referredId: string) {
  const { db, schema } = await import("../db");
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select().from(schema.referrals).where(eq(schema.referrals.referredId, referredId));
  return row ?? null;
}

test("parseRef / refFromPath / withRef: a code or a handle, nothing else, carried in a path", () => {
  assert.equal(parseRef("a1b2c3d4"), "a1b2c3d4");
  assert.equal(parseRef("Lena-Park"), "lena-park", "a handle, lowercased");
  for (const bad of ["", " ", "-lena", "a_b", "https://evil.example", "x".repeat(200), 42, null]) {
    assert.equal(parseRef(bad), null, `${String(bad)} is not a ref`);
  }
  assert.equal(refFromPath("/dashboard?ref=lena"), "lena");
  assert.equal(refFromPath("https://app.kept.host/dashboard?tab=drafts&ref=a1b2c3d4"), "a1b2c3d4");
  assert.equal(refFromPath("/dashboard?ref=%3Cscript%3E"), null);
  assert.equal(refFromPath("/dashboard"), null);
  assert.equal(refFromPath(null), null);

  assert.equal(withRef("/dashboard", "lena"), "/dashboard?ref=lena");
  assert.equal(withRef("https://app.kept.host/dashboard", "lena"), "https://app.kept.host/dashboard?ref=lena");
  assert.equal(withRef("https://app.kept.host/dashboard", "<x>"), "https://app.kept.host/dashboard", "an invalid ref is dropped");
  assert.equal(withRef("/dashboard", undefined), "/dashboard");
});

test("AC17: ?ref={code} on the sign-up's callback URL credits the referrer, verified at once (magic link)", { skip: skipLive }, async () => {
  const { referralStatsFor } = await import("./stats");
  const d = await names();
  const referrerId = await d.profile();
  const { profiles } = await import("../db/schema");
  const { db } = await import("../db");
  const { eq } = await import("drizzle-orm");
  const [referrer] = await db.select().from(profiles).where(eq(profiles.id, referrerId));

  const before = (await referralStatsFor(referrer!)).verifiedCount;
  const newcomer = await signUp(`/dashboard?ref=${referrer!.referralCode}`);

  const row = await referralOf(newcomer);
  assert.ok(row, "the hook recorded the referral (Q20: create.after sees the callback URL)");
  assert.equal(row.referrerId, referrerId);
  assert.ok(row.verifiedAt, "a magic-link address is verified, so it counts at once");

  const stats = await referralStatsFor(referrer!);
  assert.equal(stats.refCode, referrer!.referralCode, "no handle yet: the link carries the code");
  assert.equal(stats.verifiedCount, before + 1);
  assert.ok(!JSON.stringify(stats).includes("@"), "stats never carry an email");

  // A sign-up with no ref, or an unknown one, records nothing.
  assert.equal(await referralOf(await signUp("/dashboard")), null);
  assert.equal(await referralOf(await signUp("/dashboard?ref=zzzzzzzz")), null);
});

test("AC17: self-referral and a second referral are refused; a handle resolves (Q3)", { skip: skipLive }, async () => {
  const { recordSignUpReferral } = await import("./capture");
  const { setHandle } = await import("../handles/handle");
  const d = await names();
  const referrer = await d.profile();
  const other = await d.profile();
  const newcomer = await d.profile();
  const handle = d.name();
  await setHandle(referrer, handle);

  assert.equal(await recordSignUpReferral({ id: referrer, emailVerified: true }, handle), "self");
  assert.equal(await recordSignUpReferral({ id: newcomer, emailVerified: true }, "nobody-here"), "unknown");
  assert.equal(await recordSignUpReferral({ id: newcomer, emailVerified: true }, null), "none");
  assert.equal(await recordSignUpReferral({ id: newcomer, emailVerified: true }, handle), "recorded", "a current handle");
  assert.equal((await referralOf(newcomer))?.referrerId, referrer);

  const { db } = await import("../db");
  const { profiles } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");
  const [o] = await db.select().from(profiles).where(eq(profiles.id, other));
  assert.equal(
    await recordSignUpReferral({ id: newcomer, emailVerified: true }, o!.referralCode),
    "duplicate",
    "one referrer per account: the first wins",
  );
  assert.equal((await referralOf(newcomer))?.referrerId, referrer);
});

test("edge case 10: an unverified sign-up never counts until its email is verified", { skip: skipLive }, async () => {
  const { recordSignUpReferral, verifySignUpReferral } = await import("./capture");
  const { referralStatsFor } = await import("./stats");
  const { db } = await import("../db");
  const { profiles } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");
  const d = await names();
  const referrerId = await d.profile();
  const newcomer = await d.profile();
  const [referrer] = await db.select().from(profiles).where(eq(profiles.id, referrerId));

  assert.equal(await recordSignUpReferral({ id: newcomer, emailVerified: false }, referrer!.referralCode), "recorded");
  assert.equal((await referralOf(newcomer))?.verifiedAt, null);
  assert.equal((await referralStatsFor(referrer!)).verifiedCount, 0, "unverified: not counted");

  await verifySignUpReferral({ id: newcomer, emailVerified: false });
  assert.equal((await referralStatsFor(referrer!)).verifiedCount, 0, "an update that verifies nothing changes nothing");
  await verifySignUpReferral({ id: newcomer, emailVerified: true });
  const stats = await referralStatsFor(referrer!);
  assert.equal(stats.verifiedCount, 1, "counted once verified");
  assert.equal(stats.referrals.length, 1);
  assert.deepEqual(Object.keys(stats.referrals[0]!).sort(), ["createdAt", "displayName"], "a date and a display name only");
});
