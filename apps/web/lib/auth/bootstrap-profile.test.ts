/**
 * Profile bootstrap on first sign-in — E05 task 006.
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
 * handshakes belong to task 012. Their *handle seeding* is still proved here,
 * because what the hook receives from an OAuth callback is a `user` row with a
 * `name` on it and nothing more (better-auth drops the rest of `userInfo` before
 * `createOAuthUser`), and that row is what these tests construct.
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

import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

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
  "a first magic-link sign-in creates exactly one free profile, with a null handle",
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
    assert.equal(
      profile.handle,
      null,
      "a magic-link signup has no provider handle; null is complete, not a gap to fill",
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
    }
    createdUserIds.push(userId!);

    // Exactly one: the second sign-in creates no user, so no second profile.
    const profile = await soleProfileFor(userId!);
    assert.equal(
      profile.handle,
      "Round 1",
      "the handle is seeded once, at creation — a later sign-in must never re-seed it",
    );
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
      Array.from({ length: 5 }, () =>
        ensureProfile({ userId: user.id, email: user.email, handle: "Race Condition" }),
      ),
    );

    // One row, not five and not a unique violation.
    const winner = await soleProfileFor(user.id);
    for (const result of results) {
      assert.equal(result.id, winner.id, "every concurrent caller returns the winning row");
      assert.equal(result.plan, "free");
    }
  },
);

test(
  "handle is seeded at creation only and is never overwritten by a later call",
  { skip: skipLive },
  async () => {
    const { bootstrapProfile } = await import("./bootstrap-profile");
    const { ensureProfile } = await import("../db/queries/profile");

    // What an OAuth callback hands the hook: a user row carrying `name`. GitHub
    // maps `profile.name || profile.login` into it (see lib/auth/index.ts), so a
    // GitHub user with no display name arrives here as their login.
    const user = await insertAuthUser("octocat");
    await bootstrapProfile({ id: user.id, email: user.email, name: user.name });

    const seeded = await soleProfileFor(user.id);
    assert.equal(seeded.handle, "octocat", "seeded from the provider name, provider-agnostically");

    // Linking a second provider later, or E06 letting the user edit the handle,
    // must not be undone by a re-seed.
    await ensureProfile({
      userId: user.id,
      email: "someone-else@kept-e05-006.invalid",
      handle: "Jane Doe From Google",
    });
    const unchanged = await soleProfileFor(user.id);
    assert.equal(unchanged.handle, "octocat", "a second provider must not overwrite the handle");
    assert.equal(unchanged.email, user.email, "nor the email");
  },
);

test(
  "a blank provider name seeds null rather than a synthesised handle",
  { skip: skipLive },
  async () => {
    const { seedHandle } = await import("../db/queries/profile");
    const { bootstrapProfile } = await import("./bootstrap-profile");

    // better-auth's magic-link plugin creates the user with `name: name || ""`.
    assert.equal(seedHandle(""), null);
    assert.equal(seedHandle("   "), null);
    assert.equal(seedHandle(undefined), null);
    assert.equal(seedHandle(null), null);
    assert.equal(seedHandle("  octocat  "), "octocat");

    const user = await insertAuthUser("");
    await bootstrapProfile({ id: user.id, email: user.email, name: "" });
    const profile = await soleProfileFor(user.id);
    assert.equal(profile.handle, null);
    assert.equal(profile.plan, "free");
  },
);

test(
  "handle is presentation, not identity — two profiles may share one",
  { skip: skipLive },
  async () => {
    const { bootstrapProfile } = await import("./bootstrap-profile");

    const first = await insertAuthUser("Alex Kim");
    const second = await insertAuthUser("Alex Kim");
    await bootstrapProfile({ id: first.id, email: first.email, name: "Alex Kim" });
    // No unique index on `handle`; if one is ever added this insert fails, which
    // is the point of asserting it. Uniqueness is E06's problem if E06 wants it.
    await bootstrapProfile({ id: second.id, email: second.email, name: "Alex Kim" });

    assert.equal((await soleProfileFor(first.id)).handle, "Alex Kim");
    assert.equal((await soleProfileFor(second.id)).handle, "Alex Kim");
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

    const created = await getProfileForSession({
      user: { id: user.id, email: user.email, name: "Backstop User" },
    });
    assert.equal(created?.id, user.id, "the profile id IS the auth user id (D1)");
    assert.equal(created?.plan, "free");
    assert.equal(created?.handle, "Backstop User");

    // Second read is a plain lookup and returns the same row.
    const read = await getProfileForSession({
      user: { id: user.id, email: user.email, name: "Renamed Since" },
    });
    assert.equal(read?.id, created?.id);
    assert.equal(read?.handle, "Backstop User", "a lookup never re-seeds");
    await soleProfileFor(user.id);
  },
);
