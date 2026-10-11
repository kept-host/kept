/**
 * Founding applications (E06a §4, task 006): the signed review token, the
 * application upsert and its re-apply rules, the review read (changes nothing),
 * the decision (idempotent, rolled back with a failed mail), `admin:founding
 * add`'s upsert, the founding branch of `joinWaitlist`, and the mails' text.
 *
 * NO MOCKS. Real dev Neon (SKIPS without `DATABASE_URL`), Cloudflare's real
 * siteverify with its test secrets. NO MAIL is sent here: `KEPT_ADMIN_EMAILS`
 * is emptied, so the admin notice is skipped (and logged), and approvals are
 * driven through `decideFounding` with a callback of the test's own. The real
 * sends (admin notice, approval) are `e2e/founding.spec.ts`'s.
 *
 * Rows are addressed `founding-unit-…@example.com` and deleted in `after`.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { FOUNDING_REVIEW_TTL_DAYS, generateAnonToken, hashToken } from "@kept/shared";
import { config } from "dotenv";

import { setTurnstileTestKeys, TURNSTILE_TEST_KEYS } from "../testing/turnstile";

config({ path: ".env.local", quiet: true });
process.env.RATE_LIMIT_SECRET = "e06a-006-founding-test-rate-limit-secret-0123456789";
process.env.KEPT_ADMIN_SECRET = "e06a-006-founding-test-admin-secret-0123456789abcdef";
process.env.KEPT_ADMIN_EMAILS = "";

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const DAY_MS = 24 * 60 * 60 * 1000;

const emails = new Set<string>();
function address(): string {
  const email = `founding-unit-${crypto.randomUUID().slice(0, 8)}@example.com`;
  emails.add(email);
  return email;
}

function freshIp(): string {
  return `2001:db8:6:${Math.floor(Math.random() * 0xffff).toString(16)}::1`;
}

after(async () => {
  if (skipLive) return;
  const { db, closeDb } = await import("../db");
  const { waitlist } = await import("../db/schema");
  const { inArray } = await import("drizzle-orm");
  if (emails.size > 0) await db.delete(waitlist).where(inArray(waitlist.email, [...emails]));
  await closeDb();
});

async function row(email: string) {
  const { db } = await import("../db");
  const { waitlist } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");
  const [found] = await db.select().from(waitlist).where(eq(waitlist.email, email));
  return found;
}

test("review token: round-trips, expires after 14 days, refuses tampering and the unsubscribe signer", async () => {
  const { emailFromReviewToken, reviewToken } = await import("./review-token");
  const { unsubscribeToken } = await import("../waitlist/unsubscribe");
  const now = new Date("2026-10-11T12:00:00Z");
  const t = reviewToken("ada@example.com", now);

  assert.equal(emailFromReviewToken(t, now), "ada@example.com");
  const lastMoment = new Date(now.getTime() + FOUNDING_REVIEW_TTL_DAYS * DAY_MS - 1000);
  assert.equal(emailFromReviewToken(t, lastMoment), "ada@example.com", "valid until the 14th day");
  const expired = new Date(now.getTime() + FOUNDING_REVIEW_TTL_DAYS * DAY_MS + 1000);
  assert.equal(emailFromReviewToken(t, expired), null, "expired after 14 days");

  const [payload, sig] = t.split(".") as [string, string];
  const forged = Buffer.from(
    Buffer.from(payload, "base64url").toString("utf8").replace("ada@", "eve@"),
  ).toString("base64url");
  assert.equal(emailFromReviewToken(`${forged}.${sig}`, now), null, "a changed address is refused");
  const later = Buffer.from(
    Buffer.from(payload, "base64url").toString("utf8").replace(/^\d+/, "9999999999"),
  ).toString("base64url");
  assert.equal(emailFromReviewToken(`${later}.${sig}`, now), null, "a pushed-out expiry is refused");
  const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
  assert.equal(emailFromReviewToken(`${payload}.${flipped}`, now), null, "a changed signature is refused");

  assert.equal(emailFromReviewToken(unsubscribeToken("ada@example.com"), now), null, "another signer's token");
  for (const junk of [undefined, null, 42, "", "a.b", "x".repeat(2000)]) {
    assert.equal(emailFromReviewToken(junk, now), null, `junk: ${String(junk).slice(0, 12)}`);
  }

  process.env.KEPT_ADMIN_SECRET = "e06a-006-a-different-admin-secret-0123456789abcdefgh";
  try {
    assert.equal(emailFromReviewToken(t, now), null, "a rotated secret invalidates the link");
  } finally {
    process.env.KEPT_ADMIN_SECRET = "e06a-006-founding-test-admin-secret-0123456789abcdef";
  }
});

test("an application: new row pending; re-apply updates details; decided rows keep their status", { skip: skipLive }, async () => {
  const { upsertFoundingApplication } = await import("../db/queries/founding");
  const { db } = await import("../db");
  const { waitlist } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");
  const email = address();

  const first = await upsertFoundingApplication({ email, socialUrl: "https://example.com/@ada", note: "zines" });
  assert.deepEqual(first, { foundingStatus: "pending", confirmed: false });
  let current = await row(email);
  console.log(`[founding-unit] new: source=${current?.source} status=${current?.foundingStatus}`);
  assert.equal(current?.source, "founding");
  assert.equal(current?.socialUrl, "https://example.com/@ada");
  assert.equal(current?.note, "zines");

  await upsertFoundingApplication({ email, socialUrl: "https://example.com/@ada2", note: null });
  current = await row(email);
  assert.equal(current?.socialUrl, "https://example.com/@ada2", "pending: the details update");
  assert.equal(current?.note, null);
  assert.equal(current?.foundingStatus, "pending");

  for (const decided of ["approved", "declined"] as const) {
    await db.update(waitlist).set({ foundingStatus: decided, confirmedAt: new Date() }).where(eq(waitlist.email, email));
    const again = await upsertFoundingApplication({ email, socialUrl: `https://example.com/${decided}`, note: "x" });
    assert.deepEqual(again, { foundingStatus: decided, confirmed: true }, `${decided}: status stays`);
    current = await row(email);
    assert.equal(current?.socialUrl, `https://example.com/${decided}`, `${decided}: details update`);
    assert.equal(current?.note, "x");
  }

  // An existing non-applicant row becomes an applicant without losing its source.
  const subscriber = address();
  await db.insert(waitlist).values({ email: subscriber, source: "landing_nav", confirmedAt: new Date() });
  const applied = await upsertFoundingApplication({ email: subscriber, socialUrl: "https://example.com/s", note: null });
  assert.deepEqual(applied, { foundingStatus: "pending", confirmed: true }, "confirmed → Arun now");
  assert.equal((await row(subscriber))?.source, "landing_nav");

  await db.update(waitlist).set({ unsubscribedAt: new Date() }).where(eq(waitlist.email, subscriber));
  const unsubscribed = await upsertFoundingApplication({ email: subscriber, socialUrl: "https://example.com/s", note: null });
  assert.equal(unsubscribed.confirmed, false, "unsubscribed is not confirmed: the opt-in runs again first");
});

test("joinWaitlist, founding: a bad URL is a specific 400; a decided row changes nothing but details; a confirmed applicant is 202 with no confirmation", { skip: skipLive }, async () => {
  setTurnstileTestKeys("pass");
  const { joinWaitlist } = await import("../waitlist/join");
  const { db } = await import("../db");
  const { waitlist } = await import("../db/schema");
  const body = (email: string, socialUrl: string) => ({
    email,
    source: "founding",
    turnstileToken: TURNSTILE_TEST_KEYS.dummyToken,
    founding: { socialUrl, note: "comics" },
  });

  const bad = await joinWaitlist(body(address(), "javascript:alert(1)"), freshIp());
  assert.equal(bad.status, 400);
  assert.equal(!bad.ok && bad.body.message, "Enter your profile’s full address, starting with https://.");
  const tooLong = await joinWaitlist(
    { ...body(address(), "https://example.com"), founding: { socialUrl: "https://example.com", note: "x".repeat(281) } },
    freshIp(),
  );
  assert.equal(tooLong.status, 400, "a note over 280 characters");

  const approved = address();
  await db.insert(waitlist).values({
    email: approved,
    source: "admin",
    foundingStatus: "approved",
    socialUrl: "https://example.com/old",
  });
  const reapplied = await joinWaitlist(body(approved, "https://example.com/new"), freshIp());
  assert.equal(reapplied.status, 202);
  const reapplyRow = await row(approved);
  assert.equal(reapplyRow?.foundingStatus, "approved");
  assert.equal(reapplyRow?.socialUrl, "https://example.com/new");
  assert.equal(reapplyRow?.confirmSentAt, null, "no confirmation mail for a decided application");

  const confirmed = address();
  await db.insert(waitlist).values({ email: confirmed, source: "landing_drop", confirmedAt: new Date() });
  const applied = await joinWaitlist(body(confirmed, "https://example.com/c"), freshIp());
  assert.equal(applied.status, 202);
  const pending = await row(confirmed);
  assert.equal(pending?.foundingStatus, "pending");
  assert.equal(pending?.confirmSentAt, null, "already confirmed: no confirmation mail");
});

test("confirming a pending applicant reports the application; the confirm route's flag rides on it", { skip: skipLive }, async () => {
  const { upsertFoundingApplication } = await import("../db/queries/founding");
  const { upsertWaitlistJoin } = await import("../db/queries/waitlist");
  const { confirmWaitlist } = await import("../waitlist/confirm");
  const email = address();
  await upsertFoundingApplication({ email, socialUrl: "https://example.com/p", note: "songs" });
  const token = generateAnonToken();
  assert.equal(await upsertWaitlistJoin({ email, source: "founding", tokenHash: await hashToken(token) }), true);
  assert.equal((await row(email))?.confirmSendCount, 1, "the applicant gets the ordinary confirmation");

  // KEPT_ADMIN_EMAILS is empty here, so the notice is skipped (logged), never sent.
  assert.deepEqual(await confirmWaitlist({ token }), {
    email,
    foundingStatus: "pending",
    socialUrl: "https://example.com/p",
    note: "songs",
  });
});

test("review: reading changes nothing; decide is idempotent; a failed mail rolls back; missing is expired", { skip: skipLive }, async () => {
  const { decideFounding, upsertFoundingApplication } = await import("../db/queries/founding");
  const { decideFoundingReview, readFoundingReview } = await import("./review");
  const { reviewToken } = await import("./review-token");
  const email = address();
  await upsertFoundingApplication({ email, socialUrl: "https://example.com/r", note: null });
  const t = reviewToken(email);

  const read = await readFoundingReview(t);
  assert.deepEqual(read, { email, socialUrl: "https://example.com/r", note: null, foundingStatus: "pending" });
  assert.equal((await row(email))?.foundingStatus, "pending", "a read is not a decision");
  assert.equal(await readFoundingReview("tampered.x"), null);

  // A refused mail: the decision rolls back, so a retry can send it.
  await assert.rejects(
    decideFounding(email, "approved", async () => {
      throw new Error("resend refused");
    }),
  );
  assert.equal((await row(email))?.foundingStatus, "pending", "rolled back");
  assert.equal((await row(email))?.foundingDecidedAt, null);

  const mailed: string[] = [];
  const approve = () => decideFounding(email, "approved", async (decided) => void mailed.push(decided.email));
  assert.equal(await approve(), "changed");
  const approved = await row(email);
  assert.equal(approved?.foundingStatus, "approved");
  assert.ok(approved?.foundingDecidedAt);
  assert.equal(await approve(), "unchanged", "a second approve");
  assert.deepEqual(mailed, [email], "…sends nothing");
  assert.deepEqual((await row(email))?.foundingDecidedAt, approved?.foundingDecidedAt);

  // Decline through the real entry point: no mail is part of it.
  assert.deepEqual(await decideFoundingReview({ t, decision: "decline" }), {
    kind: "decided",
    status: "declined",
    emailed: false,
  });
  assert.equal((await row(email))?.foundingStatus, "declined");
  assert.deepEqual(await decideFoundingReview({ t, decision: "decline" }), {
    kind: "decided",
    status: "declined",
    emailed: false,
  });

  assert.deepEqual(await decideFoundingReview({ t, decision: "maybe" }), { kind: "invalid" });
  assert.deepEqual(await decideFoundingReview({ t: `${t}x`, decision: "approve" }), { kind: "expired" });
  const stale = reviewToken(email, new Date(Date.now() - (FOUNDING_REVIEW_TTL_DAYS + 1) * DAY_MS));
  assert.deepEqual(await decideFoundingReview({ t: stale, decision: "approve" }), { kind: "expired" });
  assert.deepEqual(
    await decideFoundingReview({ t: reviewToken(address()), decision: "approve" }),
    { kind: "expired" },
    "no application behind a valid signature",
  );
  assert.equal((await row(email))?.foundingStatus, "declined", "none of those changed anything");
});

test("upsertApprovedFounding: approves outright, no confirmation, keeps the first decision time", { skip: skipLive }, async () => {
  const { upsertApprovedFounding, upsertFoundingApplication } = await import("../db/queries/founding");
  const fresh = address();
  await upsertApprovedFounding(fresh, "https://example.com/a", "films");
  const added = await row(fresh);
  assert.equal(added?.source, "admin");
  assert.equal(added?.foundingStatus, "approved");
  assert.equal(added?.note, "films");
  assert.equal(added?.confirmedAt, null, "no marketing consent");
  assert.equal(added?.confirmSentAt, null, "no mail");
  assert.ok(added?.foundingDecidedAt);

  await upsertApprovedFounding(fresh, "https://example.com/b");
  const again = await row(fresh);
  assert.equal(again?.socialUrl, "https://example.com/b");
  assert.deepEqual(again?.foundingDecidedAt, added?.foundingDecidedAt, "already approved: decision time stays");

  const applicant = address();
  await upsertFoundingApplication({ email: applicant, socialUrl: "https://example.com/p", note: null });
  await upsertApprovedFounding(applicant, "https://example.com/p");
  const promoted = await row(applicant);
  assert.equal(promoted?.foundingStatus, "approved");
  assert.equal(promoted?.source, "founding", "an applicant keeps its source");
});

test("the mails: application subject and body; approval text verbatim with unsubscribe and footer", async () => {
  const { buildApplicationEmail, buildApprovalEmail, APPROVAL_SUBJECT } = await import("../email/founding");
  const from = "kept <page@kept.host>";
  const origin = "https://app.kept.host";

  const notice = buildApplicationEmail({
    application: { email: "ada@example.com", socialUrl: "https://example.com/@ada", note: "zines" },
    reviewUrl: "https://kept.host/founding/review?t=abc",
    from,
    origin,
  });
  assert.equal(notice.subject, "Founding application: https://example.com/@ada");
  for (const part of ["ada@example.com", "https://example.com/@ada", "zines", "https://kept.host/founding/review?t=abc", "Impressum"]) {
    assert.ok(notice.text.includes(part), `notice carries ${part}`);
  }

  const approval = buildApprovalEmail({ unsubscribeUrl: "https://kept.host/waitlist/unsubscribe?t=u", from, origin });
  assert.equal(APPROVAL_SUBJECT, "You're a kept founding creator");
  assert.equal(approval.subject, APPROVAL_SUBJECT);
  assert.ok(
    approval.text.startsWith(
      "You're in. kept opens in December, and you'll get Pro free from day one. We'll email you the moment you can sign in. Use this email address when you do.\n\n" +
        'There\'s no obligation to post about kept. If you do, please mark the post as an ad (in Germany: "Werbung" or "Anzeige"), since you got Pro for free.\n\n' +
        "Questions? Just reply. This goes to Arun.",
    ),
  );
  assert.ok(approval.text.includes("https://kept.host/waitlist/unsubscribe?t=u"));
  assert.ok(approval.text.includes("Impressum") && approval.text.includes("Privacy"));
});
