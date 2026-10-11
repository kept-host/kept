/**
 * Admin-only sign-in and the magic-link limits — E06a task 003 (PRD §2, §5).
 *
 * Everything runs against the real Better Auth instance, the real Drizzle
 * adapter and the real dev Neon branch: the hooks are reached through the
 * internal-adapter entry points Better Auth's own OAuth callback and magic-link
 * verifier call, and through `auth.handler` for the HTTP shapes. Only the
 * inbox is skipped. Every live case SKIPS without `DATABASE_URL`.
 *
 * "No mail was sent" is proved, not assumed: the drill addresses are on
 * `.invalid`, which Resend refuses at request time, and `sendMagicLink` rejects
 * on a refusal — so a 200 for one of them means the send never happened.
 *
 * Nothing here prints an address, a token or an IP.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { config } from "dotenv";

import { drillIp } from "../testing/drill-ip";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

/** Fill only what is missing — a real value in `.env.local` always wins. */
for (const [name, value] of Object.entries({
  BETTER_AUTH_SECRET: "closed-sign-in-drill-secret-not-used-for-anything-real",
  BETTER_AUTH_URL: "https://localhost:3000",
  GITHUB_CLIENT_ID: "unprovisioned.github.invalid",
  GITHUB_CLIENT_SECRET: "unprovisioned.github.invalid",
  GOOGLE_CLIENT_ID: "unprovisioned.google.invalid",
  GOOGLE_CLIENT_SECRET: "unprovisioned.google.invalid",
  RESEND_API_KEY: "unprovisioned.resend.invalid",
  EMAIL_FROM: "drill@unprovisioned.invalid",
  RATE_LIMIT_SECRET: "e06a-003-closed-sign-in-rate-limit-secret-0123456789",
})) {
  if (!process.env[name]?.trim()) process.env[name] = value;
}

const runId = crypto.randomUUID().slice(0, 8);
const adminEmail = `admin-${runId}@kept-e06a-003.invalid`;
const strangerEmail = `stranger-${runId}@kept-e06a-003.invalid`;
const existingEmail = `existing-${runId}@kept-e06a-003.invalid`;

/** This file owns the allowlist for its whole run; the dev value is not read. */
process.env.KEPT_ADMIN_EMAILS = ` ${adminEmail.toUpperCase()} `;

function setOpen(open: boolean): void {
  if (open) process.env.NEXT_PUBLIC_KEPT_OPEN = "true";
  else delete process.env.NEXT_PUBLIC_KEPT_OPEN;
}

const createdUserIds: string[] = [];
const createdBuckets: string[] = [];

after(async () => {
  if (skipLive) return;
  const { db, schema } = await import("../db");
  const { inArray, sql } = await import("drizzle-orm");
  if (createdUserIds.length) {
    // Cascades `profiles`, `session`, `account` and `verification`.
    await db.delete(schema.user).where(inArray(schema.user.id, createdUserIds));
  }
  for (const bucket of createdBuckets) {
    await db.execute(sql`delete from rate_limits where bucket = ${bucket}`);
  }
  await db.$client.end();
});

async function usersWithEmail(email: string): Promise<string[]> {
  const { db, schema } = await import("../db");
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  return rows.map((row) => row.id);
}

async function sessionCount(userId: string): Promise<number> {
  const { db, schema } = await import("../db");
  const { eq } = await import("drizzle-orm");
  return (await db.select().from(schema.session).where(eq(schema.session.userId, userId))).length;
}

/** `GET /magic-link/verify` for `email`, as the link in the mail would. */
async function verifyMagicLink(email: string): Promise<Response> {
  const { auth } = await import("./index");
  const { authConfig } = await import("../storage/env");
  const ctx = await auth.$context;
  const token = crypto.randomUUID().replace(/-/g, "");
  await ctx.internalAdapter.createVerificationValue({
    identifier: token,
    value: JSON.stringify({ email, name: "Closed Sign-in Drill" }),
    expiresAt: new Date(Date.now() + 300_000),
  });
  return auth.handler(
    new Request(`${authConfig().baseUrl}/api/auth/magic-link/verify?token=${token}`),
  );
}

/** `POST /sign-in/magic-link`, as the `/auth` form sends it, from `ip`. */
async function requestMagicLink(email: string, ip: string): Promise<Response> {
  const { auth } = await import("./index");
  const { authConfig } = await import("../storage/env");
  const { baseUrl } = authConfig();
  return auth.handler(
    new Request(`${baseUrl}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl, "cf-connecting-ip": ip },
      body: JSON.stringify({ email, callbackURL: "/dashboard" }),
    }),
  );
}

async function track(email: string, ip: string): Promise<void> {
  const { emailKey, ipKey } = await import("../rate-limit");
  createdBuckets.push(await emailKey("magic-link", email), await ipKey("magic-link", ip));
}

function assertNotOpen(error: unknown): true {
  assert.equal((error as { body?: { code?: string } }).body?.code, "not_open");
  assert.equal((error as Error).message, "not_open", "the OAuth callback redirects with the message");
  return true;
}

test("the address predicate: open lets anyone in (D9); closed only the allowlist", async () => {
  const { maySignIn, refuseUserUnlessMaySignIn, refuseSessionUnlessMaySignIn } = await import(
    "./closed-sign-in"
  );
  setOpen(true);
  assert.equal(maySignIn(strangerEmail), true);
  refuseUserUnlessMaySignIn(strangerEmail);
  // Open never even looks the user up — an id with no row passes.
  await refuseSessionUnlessMaySignIn(crypto.randomUUID());

  setOpen(false);
  assert.equal(maySignIn(adminEmail), true);
  assert.equal(maySignIn(` ${adminEmail.toUpperCase()}`), true);
  assert.equal(maySignIn(strangerEmail), false);
  refuseUserUnlessMaySignIn(adminEmail);
  assert.throws(() => refuseUserUnlessMaySignIn(strangerEmail), assertNotOpen);
});

test("closed: the session hook resolves the address from the user row", { skip: skipLive }, async () => {
  const { refuseSessionUnlessMaySignIn } = await import("./closed-sign-in");
  // Minted while open, so the fixtures are not refused by what is under test.
  setOpen(true);
  for (const email of [adminEmail, existingEmail]) {
    const verified = await verifyMagicLink(email);
    assert.equal(verified.status, 200, "fixture sign-in");
    createdUserIds.push(((await verified.json()) as { user: { id: string } }).user.id);
  }
  const [adminId] = await usersWithEmail(adminEmail);
  const [existingId] = await usersWithEmail(existingEmail);

  setOpen(false);
  await refuseSessionUnlessMaySignIn(adminId!);
  await assert.rejects(refuseSessionUnlessMaySignIn(existingId!), assertNotOpen);
  await assert.rejects(refuseSessionUnlessMaySignIn(crypto.randomUUID()), assertNotOpen);
});

test(
  "closed: the OAuth entry points refuse a non-admin — no user, no account, no session",
  { skip: skipLive },
  async () => {
    const { auth } = await import("./index");
    const internal = (await auth.$context).internalAdapter;
    setOpen(false);

    // A first OAuth sign-in: `handleOAuthUserInfo` → `createOAuthUser`.
    await assert.rejects(
      internal.createOAuthUser(
        { email: strangerEmail, emailVerified: true, name: "Stranger" },
        { providerId: "github", accountId: `e06a-003-${runId}` },
      ),
      assertNotOpen,
    );
    assert.deepEqual(await usersWithEmail(strangerEmail), [], "the transaction rolled back");

    // A returning user on any door ends in `createSession`.
    const [existingId] = await usersWithEmail(existingEmail);
    const before = await sessionCount(existingId!);
    await assert.rejects(internal.createSession(existingId!), assertNotOpen);
    assert.equal(await sessionCount(existingId!), before);
  },
);

test(
  "closed: magic-link verify signs an admin in and refuses anyone else without a cookie",
  { skip: skipLive },
  async () => {
    setOpen(false);

    const admin = await verifyMagicLink(adminEmail);
    assert.equal(admin.status, 200, "an admin signs in while closed");
    assert.ok(
      admin.headers.getSetCookie().some((c) => c.startsWith("__Host-kept.session_token=")),
      "the admin gets a session cookie",
    );

    for (const email of [strangerEmail, existingEmail]) {
      const refused = await verifyMagicLink(email);
      assert.equal(refused.status, 403);
      assert.equal(((await refused.json()) as { code: string }).code, "not_open");
      assert.deepEqual(refused.headers.getSetCookie(), [], "no Set-Cookie");
    }
    assert.deepEqual(await usersWithEmail(strangerEmail), [], "no user row for a stranger");
    const [existingId] = await usersWithEmail(existingEmail);
    assert.equal(await sessionCount(existingId!), 1, "only the fixture's open-mode session");
  },
);

test(
  "closed: a magic-link request for a non-admin sends nothing and answers like any other",
  { skip: skipLive },
  async () => {
    setOpen(false);
    const ip = drillIp();
    await track(strangerEmail, ip);
    const response = await requestMagicLink(strangerEmail, ip);
    // A send to `.invalid` would have been refused by Resend and rejected.
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { status: true });
    assert.deepEqual(await usersWithEmail(strangerEmail), []);
  },
);

test(
  "magic-link limits: the 4th request for one address in an hour is a 429 with Retry-After",
  { skip: skipLive },
  async () => {
    setOpen(false);
    const email = `limit-email-${runId}@kept-e06a-003.invalid`;
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 4; i += 1) {
      // A fresh network each time, so only the per-address bucket can trip.
      const ip = drillIp();
      await track(email, ip);
      const response = await requestMagicLink(email, ip);
      statuses.push(response.status);
      retryAfter = response.headers.get("retry-after");
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);
    assert.ok(Number(retryAfter) >= 1 && Number(retryAfter) <= 3600, "Retry-After in seconds");
  },
);

test(
  "magic-link limits: the 6th request from one IP in an hour is a 429, open or closed",
  { skip: skipLive },
  async () => {
    // Open here: the limit is not closed-only (PRD §5). An open deploy would
    // really mail these, so the first five use a closed gate to keep Resend
    // out of it, and only the sixth — refused before any send — runs open.
    const ip = drillIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      setOpen(i === 5);
      const email = `limit-ip-${i}-${runId}@kept-e06a-003.invalid`;
      await track(email, ip);
      const response = await requestMagicLink(email, ip);
      statuses.push(response.status);
      if (i === 5) assert.ok(response.headers.get("retry-after"), "Retry-After present");
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  },
);
