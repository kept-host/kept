/**
 * The waitlist's double opt-in (E06a §3, task 005): the join state machine, the
 * confirmation, the signed unsubscribe, the prune, and `joinWaitlist`'s refusals.
 *
 * NO MOCKS. Everything runs against the real dev Neon branch (migration 0007)
 * and SKIPS without `DATABASE_URL`; Turnstile is Cloudflare's real siteverify
 * with its published test secrets. No mail is sent here — every case below is
 * one where `joinWaitlist` refuses before the send, or where the state machine
 * is driven through `upsertWaitlistJoin` directly. The one real send (AC8) is
 * `e2e/waitlist-opt-in.spec.ts`'s.
 *
 * Rows are addressed `waitlist-unit-…@example.com` and deleted in `after`.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { RATE_LIMITS, generateAnonToken, hashToken } from "@kept/shared";
import { config } from "dotenv";

import { setTurnstileTestKeys, TURNSTILE_TEST_KEYS } from "../testing/turnstile";

config({ path: ".env.local", quiet: true });
process.env.RATE_LIMIT_SECRET = "e06a-005-waitlist-test-rate-limit-secret-0123456789";
process.env.KEPT_ADMIN_SECRET = "e06a-005-waitlist-test-admin-secret-0123456789abcdef";

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const emails = new Set<string>();
function address(): string {
  const email = `waitlist-unit-${crypto.randomUUID().slice(0, 8)}@example.com`;
  emails.add(email);
  return email;
}

/** A client address from the documentation range, new per call (own IP bucket). */
function freshIp(): string {
  return `2001:db8:5:${Math.floor(Math.random() * 0xffff).toString(16)}::1`;
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

/** Move the last send back in time, as if `ago` had passed. */
async function age(email: string, ago: string) {
  const { db } = await import("../db");
  const { sql } = await import("drizzle-orm");
  await db.execute(
    sql`update waitlist set confirm_sent_at = confirm_sent_at - ${ago}::interval where email = ${email}`,
  );
}

/** Pretend the last send was `ago` before now, with `count` sends that day. */
async function setSent(email: string, ago: string, count?: number) {
  const { db } = await import("../db");
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`
    update waitlist
    set confirm_sent_at = now() - ${ago}::interval,
        confirm_send_count = coalesce(${count ?? null}::int, confirm_send_count)
    where email = ${email}
  `);
}

const utcDate = (date: Date) => date.toISOString().slice(0, 10);

async function join(email: string, source: "landing_nav" | "landing_drop" = "landing_nav") {
  const { upsertWaitlistJoin } = await import("../db/queries/waitlist");
  const token = generateAnonToken();
  const send = await upsertWaitlistJoin({ email, source, tokenHash: await hashToken(token) });
  return { send, token };
}

test("the join state machine: new, cooldown, daily cap, new UTC day, confirmed", { skip: skipLive }, async () => {
  const email = address();

  const first = await join(email, "landing_drop");
  assert.equal(first.send, true, "a new address gets a mail");
  const current = await row(email);
  assert.equal(current?.source, "landing_drop");
  assert.equal(current?.confirmSendCount, 1);
  assert.equal(current?.confirmTokenHash, await hashToken(first.token), "only the digest is stored");
  assert.ok(current?.confirmSentAt);
  assert.equal(current?.confirmedAt, null);

  assert.equal((await join(email)).send, false, "a repeat inside 10 minutes sends nothing");
  assert.equal((await row(email))?.confirmTokenHash, await hashToken(first.token), "and keeps the token");

  // Past the cooldown: a second send. (Same UTC day unless this runs in the
  // first 11 minutes after midnight, when the count restarts at 1.)
  await setSent(email, "11 minutes");
  let sameDay = utcDate((await row(email))!.confirmSentAt!) === utcDate(new Date());
  assert.equal((await join(email)).send, true, "past the cooldown: second send");
  assert.equal((await row(email))?.confirmSendCount, sameDay ? 2 : 1);

  // Three sends already today: the fourth sends nothing, cooldown or not.
  await setSent(email, "11 minutes", 3);
  sameDay = utcDate((await row(email))!.confirmSentAt!) === utcDate(new Date());
  assert.equal((await join(email)).send, !sameDay, "a fourth send in one UTC day sends nothing");

  await setSent(email, "1 day", 3);
  const nextDay = await join(email);
  assert.equal(nextDay.send, true, "a new UTC day resets the count");
  assert.equal((await row(email))?.confirmSendCount, 1);

  const { confirmWaitlist } = await import("./confirm");
  assert.ok(await confirmWaitlist({ token: nextDay.token }));
  assert.equal((await join(email)).send, false, "a confirmed address gets no mail");
  await age(email, "2 days");
  assert.equal((await join(email)).send, false, "not even days later");
});

test("unsubscribed and legacy rows get a fresh token and a mail", { skip: skipLive }, async () => {
  const { db } = await import("../db");
  const { waitlist } = await import("../db/schema");
  const { unsubscribeWaitlist, unsubscribeToken } = await import("./unsubscribe");
  const { confirmWaitlist } = await import("./confirm");

  const email = address();
  const { token } = await join(email);
  assert.ok(await confirmWaitlist({ token }));
  await unsubscribeWaitlist(unsubscribeToken(email));
  let current = await row(email);
  assert.ok(current?.unsubscribedAt, "unsubscribed_at is set");
  assert.ok(current?.confirmedAt, "the row stays");

  const rejoin = await join(email);
  assert.equal(rejoin.send, true, "an unsubscribed address may rejoin");
  current = await row(email);
  assert.equal(current?.unsubscribedAt, null);
  assert.equal(current?.confirmedAt, null, "rejoining is a fresh double opt-in");
  assert.equal(current?.confirmTokenHash, await hashToken(rejoin.token));

  const legacy = address();
  await db.insert(waitlist).values({ email: legacy });
  assert.equal((await row(legacy))?.source, "legacy");
  assert.equal((await join(legacy, "landing_drop")).send, true, "a legacy 0006 row gets its first mail");
  assert.equal((await row(legacy))?.source, "landing_drop");
});

test("confirm: GET-free, one use, 7-day TTL, unknown and malformed refused", { skip: skipLive }, async () => {
  const { confirmWaitlist } = await import("./confirm");
  const email = address();
  const { token } = await join(email);

  assert.equal(await confirmWaitlist({ token: generateAnonToken() }), null, "unknown token");
  assert.equal(await confirmWaitlist({ token: "short" }), null, "malformed token");
  assert.equal(await confirmWaitlist(null), null, "no body");

  const confirmed = await confirmWaitlist({ token });
  assert.deepEqual(confirmed, { email, foundingStatus: null });
  const current = await row(email);
  assert.ok(current?.confirmedAt);
  assert.equal(current?.confirmTokenHash, null, "the digest is cleared");
  assert.equal(await confirmWaitlist({ token }), null, "a used token is refused");

  const late = address();
  const stale = await join(late);
  await age(late, "8 days");
  assert.equal(await confirmWaitlist({ token: stale.token }), null, "older than 7 days is refused");
  assert.equal((await row(late))?.confirmedAt, null);
});

test("unsubscribe tokens: stable per address, tamper-proof, bound to the secret", async () => {
  const { emailFromUnsubscribeToken, unsubscribeToken } = await import("./unsubscribe");
  const token = unsubscribeToken("ada@example.com");
  assert.equal(unsubscribeToken("ada@example.com"), token, "stable");
  assert.equal(emailFromUnsubscribeToken(token), "ada@example.com");
  assert.notEqual(unsubscribeToken("bob@example.com"), token);

  const [payload, signature] = token.split(".");
  const forged = `${Buffer.from("bob@example.com").toString("base64url")}.${signature}`;
  assert.equal(emailFromUnsubscribeToken(forged), null, "another address under this signature");
  assert.equal(emailFromUnsubscribeToken(`${payload}.${"A".repeat(43)}`), null, "a made-up signature");
  for (const junk of [undefined, null, 42, "", "nodot", `${payload}.`, `${"a".repeat(2000)}.x`]) {
    assert.equal(emailFromUnsubscribeToken(junk), null, String(junk));
  }

  const saved = process.env.KEPT_ADMIN_SECRET;
  process.env.KEPT_ADMIN_SECRET = "a-different-admin-secret-for-the-rotation-case-0123";
  try {
    assert.equal(emailFromUnsubscribeToken(token), null, "rotating the secret invalidates old links");
  } finally {
    process.env.KEPT_ADMIN_SECRET = saved;
  }
});

test("the visible link and the RFC 8058 headers point at the apex", async () => {
  const { waitlistUnsubscribe, buildConfirmationEmail } = await import("../email/waitlist");
  const { url, headers } = waitlistUnsubscribe("ada@example.com", "https://app.kept.host");
  assert.match(url, /^https:\/\/kept\.host\/waitlist\/unsubscribe\?t=[A-Za-z0-9_.%-]+$/);
  assert.match(headers["List-Unsubscribe"]!, /^<https:\/\/kept\.host\/api\/waitlist\/unsubscribe\?t=/);
  assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");

  const mail = buildConfirmationEmail({
    token: "TOKEN_abc",
    from: "kept <page@kept.host>",
    origin: "https://app.kept.host",
  });
  console.log(`[waitlist] confirmation mail:\n${mail.text}`);
  assert.ok(mail.text.includes("https://kept.host/waitlist/confirm?t=TOKEN_abc"));
  assert.ok(mail.text.includes("If this wasn't you, ignore this. Nothing else will arrive."));
  assert.ok(
    mail.text.includes(
      "Email me about kept: the launch, product news and offers. Unsubscribe anytime in one click. Privacy: https://kept.host/legal/privacy",
    ),
    "the consent line, its link made absolute",
  );
  assert.ok(mail.text.includes("Impressum: https://kept.host/legal/impressum"), "004's footer");
  assert.ok(!/app\.kept\.host/.test(mail.text), "never the app. host");
});

test("prune: stale unconfirmed and legacy go; confirmed, approved and fresh stay; idempotent", { skip: skipLive }, async () => {
  const { db } = await import("../db");
  const { waitlist } = await import("../db/schema");
  const { sql } = await import("drizzle-orm");
  const { pruneWaitlist } = await import("../db/queries/waitlist");
  const { confirmWaitlist } = await import("./confirm");

  const stale = address();
  await join(stale);
  await age(stale, "31 days");

  const legacy = address();
  await db.insert(waitlist).values({ email: legacy });

  const fresh = address();
  await join(fresh);

  const confirmedOld = address();
  const { token } = await join(confirmedOld);
  await confirmWaitlist({ token });
  await age(confirmedOld, "60 days");

  const approved = address();
  await join(approved);
  await db.execute(sql`update waitlist set founding_status = 'approved' where email = ${approved}`);
  await age(approved, "60 days");

  assert.ok((await pruneWaitlist()) >= 2);
  assert.equal(await row(stale), undefined, "unconfirmed 30+ days after the last send");
  assert.equal(await row(legacy), undefined, "legacy, never confirmed");
  assert.ok(await row(fresh), "unconfirmed but recent");
  assert.ok(await row(confirmedOld), "confirmed");
  assert.ok(await row(approved), "an approved founding creator");

  // Idempotent: nothing of ours is left to delete (other rows on dev may exist,
  // but a second run right after the first finds none).
  assert.equal(await pruneWaitlist(), 0);
});

test("joinWaitlist: the 6th request in an hour from one IP is 429 with Retry-After", { skip: skipLive }, async () => {
  const { joinWaitlist } = await import("./join");
  const ip = freshIp();
  for (let i = 1; i <= RATE_LIMITS.waitlistPerIp.limit; i += 1) {
    const outcome = await joinWaitlist({ email: "not-an-address" }, ip);
    assert.equal(outcome.status, 400, `request ${i} is counted, then refused for its body`);
  }
  const sixth = await joinWaitlist({ email: "not-an-address" }, ip);
  assert.equal(sixth.status, 429);
  assert.ok(!sixth.ok && sixth.body.error === "rate_limited");
  assert.ok(!sixth.ok && (sixth.body.retry_after_seconds ?? 0) >= 1);
  assert.ok(!sixth.ok && sixth.body.message === "Too many tries, try again in a bit.");
});

test("joinWaitlist: a missing or failing Turnstile token is 400 and stores nothing", { skip: skipLive }, async () => {
  const { joinWaitlist } = await import("./join");
  const saved = {
    secret: process.env.TURNSTILE_SECRET_KEY,
    site: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
  };
  try {
    const missing = address();
    const noToken = await joinWaitlist({ email: missing, source: "landing_nav" }, freshIp());
    assert.equal(noToken.status, 400);
    assert.equal(await row(missing), undefined);

    setTurnstileTestKeys("fail");
    const refused = address();
    const outcome = await joinWaitlist(
      { email: refused, source: "landing_nav", turnstileToken: TURNSTILE_TEST_KEYS.dummyToken },
      freshIp(),
    );
    assert.equal(outcome.status, 400);
    assert.ok(!outcome.ok && outcome.body.error === "turnstile_failed");
    assert.equal(await row(refused), undefined, "nothing stored, so nothing sent");
  } finally {
    for (const [key, value] of [
      ["TURNSTILE_SECRET_KEY", saved.secret],
      ["NEXT_PUBLIC_TURNSTILE_SITE_KEY", saved.site],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("joinWaitlist: a full global confirmation-mail cap is 429 before the row is read", { skip: skipLive }, async () => {
  const { db } = await import("../db");
  const { sql } = await import("drizzle-orm");
  const { CONFIRMATION_MAILS_BUCKET, joinWaitlist } = await import("./join");
  const { windowSeconds, limit } = RATE_LIMITS.confirmationMailsGlobal;
  const windowStart = sql`to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds})`;

  // Fill this hour's real bucket, and put back exactly what was there after.
  const [before] = await db.execute<{ count: number }>(
    sql`select count from rate_limits where bucket = ${CONFIRMATION_MAILS_BUCKET} and window_start = ${windowStart}`,
  );
  await db.execute(sql`
    insert into rate_limits (bucket, window_start, count) values (${CONFIRMATION_MAILS_BUCKET}, ${windowStart}, ${limit})
    on conflict (bucket, window_start) do update set count = ${limit}
  `);
  const saved = process.env.TURNSTILE_SECRET_KEY;
  try {
    setTurnstileTestKeys("pass");
    const email = address();
    const outcome = await joinWaitlist(
      { email, source: "landing_nav", turnstileToken: TURNSTILE_TEST_KEYS.dummyToken },
      freshIp(),
    );
    assert.equal(outcome.status, 429);
    assert.ok(!outcome.ok && (outcome.body.retry_after_seconds ?? 0) >= 1);
    assert.equal(await row(email), undefined, "refused before the upsert");
  } finally {
    if (saved === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = saved;
    await db.execute(
      before
        ? sql`update rate_limits set count = ${before.count} where bucket = ${CONFIRMATION_MAILS_BUCKET} and window_start = ${windowStart}`
        : sql`delete from rate_limits where bucket = ${CONFIRMATION_MAILS_BUCKET} and window_start = ${windowStart}`,
    );
  }
});
