/**
 * Profile bootstrap on first sign-in — E05 task 006; E10 task 002 (no seeded
 * handle, a database-minted referral code — AC14).
 *
 * Lives in `lib/auth/` rather than beside `lib/db/queries/profile.ts` for one
 * mechanical reason: `test:unit` globs one directory deep under `lib/`, so a
 * file at `lib/db/queries/` would never be seen. A test that does not run is not
 * a test. It exercises the query module directly all the same — the
 * bootstrap module is four lines of glue over it, and both are proved below.
 *
 * NO MOCKS (project rule). Real `auth` instance from `./index.ts`, real Drizzle
 * adapter, real dev Neon branch, real `databaseHooks.user.create.after`, real
 * `ON CONFLICT DO NOTHING` racing on a real Postgres primary key. Nothing here
 * asserts against a fake; the concurrency test forces the race rather than
 * reasoning about it.
 *
 * WHAT IS SKIPPED, AND WHY IT IS NOT A MOCK: the **email transport**, exactly as
 * `./session-lifecycle.test.ts` skips it — the magic-link verification value is
 * written through the plugin's own storage contract and the REAL
 * `/api/auth/magic-link/verify` endpoint is then called with it. The live OAuth
 * handshakes belong to task 012. That a provider name seeds *nothing* is still
 * proved here, because what the hook receives from an OAuth callback is a `user`
 * row with a `name` on it and nothing more (better-auth drops the rest of
 * `userInfo` before `createOAuthUser`), and that row is what these tests construct.
 *
 * SKIPS without `DATABASE_URL`: CI runs `pnpm test` on fork PRs with no secrets.
 * Run locally with `pnpm --filter @kept/web test:unit`.
 *
 * EVERY IMPORT OF `./index`, `./bootstrap-profile` AND `../db` IS DYNAMIC AND
 * INSIDE A TEST, because they reach `process.env` on first use and a static
 * import would turn "skipped" into "the file failed to load".
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { referralCodeSchema } from "@kept/shared";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

// These drills sign people in on an OPEN deploy. A closed one refuses every
// non-admin session (`lib/auth/closed-sign-in.test.ts`), and the unit env
// inherits whatever the gate is.
process.env.NEXT_PUBLIC_KEPT_OPEN = "true";

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

/**
 * Fill only what is missing, exactly as the sibling auth tests do: a real value
 * in `.env.local` always wins, so this can never hide a misconfiguration.
 * Constructing the auth instance validates all eight auth variables, and the
 * OAuth/Resend credentials are not provisioned yet. No code path below transmits
 * them — no OAuth endpoint, no token exchange, no Resend call is reached — so
 * they are configuration the flow never uses, not a stub standing in for a
 * service.
 */
for (const [name, value] of Object.entries({
  BETTER_AUTH_SECRET: "bootstrap-profile-drill-secret-not-used-for-anything-real",
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

const baseUrl = (process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL)!.replace(
  /\/+$/,
  "",
);

const runId = crypto.randomUUID().slice(0, 8);

const createdUserIds: string[] = [];

after(async () => {
  if (skipLive) return;
  const { db, schema } = await import("../db");
  const { inArray } = await import("drizzle-orm");
  if (createdUserIds.length) {
    // Cascades `profiles`, `session`, `account` and `verification`.
    await db.delete(schema.user).where(inArray(schema.user.id, createdUserIds));
  }
  await db.$client.end();
});

/**
 * A real `user` row, inserted directly — the state the hook's `after` callback
 * is handed, and the FK parent `profiles.id` requires. Not created through
 * `internalAdapter.createUser`, because that fires the bootstrap hook and would
 * leave nothing for the query-module tests to prove.
 */
async function insertAuthUser(
  name: string,
): Promise<{ id: string; email: string; name: string }> {
  const { db, schema } = await import("../db");
  const id = crypto.randomUUID();
  const email = `bootstrap-${id.slice(0, 8)}@kept-e05-006.invalid`;
  await db.insert(schema.user).values({ id, name, email, emailVerified: true });
  createdUserIds.push(id);
  return { id, email, name };
}

async function profileRowsFor(userId: string) {
  const { db, schema } = await import("../db");
  const { eq } = await import("drizzle-orm");
  return db.select().from(schema.profiles).where(eq(schema.profiles.id, userId));
}

/** The one profile a user must have. Asserts the count, so no caller repeats it. */
async function soleProfileFor(userId: string) {
  const rows = await profileRowsFor(userId);
  assert.equal(rows.length, 1, `expected exactly one profile for auth user ${userId}`);
  const [profile] = rows;
  assert.ok(profile);
  return profile;
}

// ── The hook, through a real sign-in ────────────────────────────────────────

test(
  "a first magic-link sign-in creates exactly one free profile, with a null handle and a referral code",
  { skip: skipLive },
  async () => {
    const { auth } = await import("./index");

    const email = `magic-${runId}@kept-e05-006.invalid`;
    const ctx = await auth.$context;

    // The inbox, and only the inbox. `storeToken` defaults to "plain", so the
    // identifier IS the token `sendMagicLink` would have put in the URL. No
    // `name` is carried, because kept's sign-in form asks for an email and
    // nothing else — this is the real shape of a magic-link signup.
    const token = crypto.randomUUID().replace(/-/g, "");
    await ctx.internalAdapter.createVerificationValue({
      identifier: token,
      value: JSON.stringify({ email }),
      expiresAt: new Date(Date.now() + 300_000),
    });

    const verified = await auth.handler(
      new Request(`${baseUrl}/api/auth/magic-link/verify?token=${token}`),
    );
    assert.equal(verified.status, 200, await verified.clone().text());
    const body = (await verified.json()) as { user: { id: string; email: string } };
    createdUserIds.push(body.user.id);

    // Asserts the count too: the create.after hook made exactly one profile.
    const profile = await soleProfileFor(body.user.id);
    assert.equal(
      profile.id,
      body.user.id,
      "profiles.id IS the auth user id — task 002's D1, not a generated value",
    );
    assert.equal(profile.plan, "free", "every profile starts free; premium is E11's to grant");
    assert.equal(profile.email, email, "email comes from the verified email on the session");
    assert.equal(profile.handle, null, "a handle is chosen, never seeded (E10 D9, AC14)");
    console.log(`[bootstrap-profile] minted referral code: ${profile.referralCode}`);
    assert.ok(
      referralCodeSchema.safeParse(profile.referralCode).success,
      `the referral code ${profile.referralCode} is well-shaped (Q3)`,
    );
  },
);

test(
  "signing in again through the same door does not make a second profile",
  { skip: skipLive },
  async () => {
    const { auth } = await import("./index");

    const email = `repeat-${runId}@kept-e05-006.invalid`;
    const ctx = await auth.$context;

    let userId: string | undefined;
    const codes: string[] = [];
    for (const round of [1, 2]) {
      const token = crypto.randomUUID().replace(/-/g, "");
      await ctx.internalAdapter.createVerificationValue({
        identifier: token,
        value: JSON.stringify({ email, name: `Round ${round}` }),
        expiresAt: new Date(Date.now() + 300_000),
      });
      const verified = await auth.handler(
        new Request(`${baseUrl}/api/auth/magic-link/verify?token=${token}`),
      );
      assert.equal(verified.status, 200, await verified.clone().text());
      const body = (await verified.json()) as { user: { id: string } };
      userId ??= body.user.id;
      assert.equal(body.user.id, userId, "both sign-ins land in the same account");
      if (round === 1) createdUserIds.push(userId);
      // Exactly one: the second sign-in creates no user, so no second profile.
      codes.push((await soleProfileFor(userId)).referralCode);
    }

    assert.equal(codes[0], codes[1], "the referral code is permanent — a sign-in never re-mints it");
    assert.equal((await soleProfileFor(userId!)).handle, null, "a provider name never seeds a handle");
  },
);

// ── The create-once, under the race it exists for ───────────────────────────

test(
  "five simultaneous first sign-ins produce exactly one profile row",
  { skip: skipLive },
  async () => {
    const { ensureProfile } = await import("../db/queries/profile");

    const user = await insertAuthUser("Race Condition");

    // The replayed OAuth callback, forced: five callers that all see "no
    // profile" and all insert, on five real connections against one real
    // primary key. Without ON CONFLICT DO NOTHING four of these are a unique
    // violation in the user's face.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ensureProfile({ userId: user.id, email: user.email })),
    );

    // One row, not five and not a unique violation.
    const winner = await soleProfileFor(user.id);
    for (const result of results) {
      assert.equal(result.id, winner.id, "every concurrent caller returns the winning row");
      assert.equal(result.plan, "free");
      assert.equal(result.referralCode, winner.referralCode, "and the one code it was minted with");
    }
  },
);

test(
  "a provider name seeds no handle, and a later call rewrites neither the email nor the code",
  { skip: skipLive },
  async () => {
    const { bootstrapProfile } = await import("./bootstrap-profile");
    const { ensureProfile } = await import("../db/queries/profile");

    // What an OAuth callback hands the hook: a user row carrying `name`. Before
    // E10 that name became the handle; now the handle is a name in the page
    // namespace and only its owner sets it (D9).
    const user = await insertAuthUser("octocat");
    await bootstrapProfile({ id: user.id, email: user.email });

    const created = await soleProfileFor(user.id);
    assert.equal(created.handle, null, "no handle from a provider name");

    // Linking a second provider later must not touch the row.
    await ensureProfile({ userId: user.id, email: "someone-else@kept-e05-006.invalid" });
    const unchanged = await soleProfileFor(user.id);
    assert.equal(unchanged.email, user.email, "the email is set at creation only");
    assert.equal(unchanged.referralCode, created.referralCode, "the code is permanent (Q3)");
  },
);

test(
  "two sign-ups get two different referral codes",
  { skip: skipLive },
  async () => {
    const { bootstrapProfile } = await import("./bootstrap-profile");

    const first = await insertAuthUser("Alex Kim");
    const second = await insertAuthUser("Alex Kim");
    await bootstrapProfile({ id: first.id, email: first.email });
    await bootstrapProfile({ id: second.id, email: second.email });

    const [a, b] = [await soleProfileFor(first.id), await soleProfileFor(second.id)];
    assert.equal(a.handle, null);
    assert.equal(b.handle, null);
    assert.notEqual(a.referralCode, b.referralCode);
  },
);

// ── The single session→profile resolution tasks 008 and 010 consume ─────────

test(
  "getProfileForSession returns null signed out, and bootstraps a missing profile",
  { skip: skipLive },
  async () => {
    const { getProfileForSession } = await import("../db/queries/profile");

    assert.equal(await getProfileForSession(null), null, "no session is no profile");

    // The backstop: an auth user that predates this task, or arrives through a
    // future door outside better-auth, still resolves to an owner id rather than
    // failing a keep with "no profile".
    const user = await insertAuthUser("Backstop User");
    assert.deepEqual(await profileRowsFor(user.id), [], "no profile exists yet");

    const created = await getProfileForSession({ user: { id: user.id, email: user.email } });
    assert.equal(created?.id, user.id, "the profile id IS the auth user id (D1)");
    assert.equal(created?.plan, "free");
    assert.equal(created?.handle, null);
    assert.ok(referralCodeSchema.safeParse(created?.referralCode).success);

    // Second read is a plain lookup and returns the same row.
    const read = await getProfileForSession({ user: { id: user.id, email: user.email } });
    assert.equal(read?.id, created?.id);
    assert.equal(read?.referralCode, created?.referralCode, "a lookup never re-mints");
    await soleProfileFor(user.id);
  },
);
