/**
 * D2's refusal, at the level of the asset — E05 task 003.
 *
 * `github-identity.test.ts` proves the policy decides correctly. This file
 * proves the decision has the consequence D2 claims, against the real database:
 * a GitHub identity whose email matches an existing account but which GitHub
 * does NOT report verified must not resolve to that account, must not get a
 * session on it, and must reach none of its kept pages. **Assert on the pages,
 * not only on the session** — the session is the mechanism, the pages are the
 * asset.
 *
 * NO MOCKS (project rule). This runs the real `auth` instance configured in
 * `./index.ts` — the real Drizzle adapter, the real `accountLinking` policy, the
 * real uuid `generateId` — against the real dev Neon branch, and calls the exact
 * `internalAdapter` entry points Better Auth's own OAuth callback calls
 * (`findOAuthUser` then `createOAuthUser`, see `oauth2/link-account.mjs`).
 *
 * WHAT IS SUPPLIED RATHER THAN REAL, AND WHY THAT IS NOT A MOCK: constructing
 * the auth instance validates all eight auth variables, and the OAuth client
 * credentials do not exist yet (a human must provision the GitHub OAuth app,
 * the Google Cloud client and the Resend domain — see task 003's Notes). Any
 * absent ones are filled below with values on the `.invalid` TLD. Nothing in
 * this file transmits them: no OAuth endpoint, no token exchange, no Resend
 * call is reached. They are configuration the code path never uses, not a stub
 * standing in for a service. The live GitHub/Google round trip is task 012's,
 * and it is the one thing a test without credentials genuinely cannot prove.
 *
 * SKIPS without `DATABASE_URL`: CI runs `pnpm test` on fork PRs with no
 * secrets. Run locally with `pnpm --filter @kept/web test:unit`.
 *
 * EVERY IMPORT OF `./index` AND `../db` IS DYNAMIC AND INSIDE A TEST, because
 * both reach `process.env` on first use and a static import would turn "skipped"
 * into "the file failed to load".
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { config } from "dotenv";

import { selectGithubIdentity, type GithubProfileLike } from "./github-identity";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

/**
 * Fill only what is missing. A real value in `.env.local` always wins, so this
 * never hides a misconfiguration; it only lets the database half of the policy
 * be exercised before the OAuth apps exist.
 */
for (const [name, value] of Object.entries({
  BETTER_AUTH_SECRET: "linking-refusal-drill-secret-not-used-for-anything-real",
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

const runId = crypto.randomUUID().slice(0, 8);
const victimEmail = `victim-${runId}@kept-e05-003.invalid`;

/** The attacker's GitHub account: profile email set to the victim's address. */
const attackerProfile: GithubProfileLike = {
  id: `9${runId.replace(/\D/g, "").padEnd(6, "0").slice(0, 6)}`,
  login: `not-victim-${runId}`,
  name: "Not The Victim",
  email: victimEmail,
};

const createdUserIds: string[] = [];
const createdSiteIds: string[] = [];

after(async () => {
  if (skipLive) return;
  const { db, schema } = await import("../db");
  const { inArray } = await import("drizzle-orm");
  if (createdSiteIds.length) {
    await db.delete(schema.sites).where(inArray(schema.sites.id, createdSiteIds));
  }
  if (createdUserIds.length) {
    // Cascades `profiles`, `session` and `account`.
    await db.delete(schema.user).where(inArray(schema.user.id, createdUserIds));
  }
  await db.$client.end();
});

test("an unverified provider email reaches neither the account nor its pages", { skip: skipLive }, async () => {
  const { auth } = await import("./index");
  const { db, schema } = await import("../db");
  const { eq } = await import("drizzle-orm");

  const ctx = await auth.$context;
  const internal = ctx.internalAdapter;

  // ── The victim: a verified account holding one kept page ───────────────────
  const victim = await internal.createUser({
    email: victimEmail,
    emailVerified: true,
    name: "Victim",
  });
  createdUserIds.push(victim.id);

  // D1, incidentally proved again: the adapter inserted a uuid, not a text id.
  assert.match(
    victim.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "advanced.database.generateId must mint uuids (D1)",
  );

  // The `profiles` row that `sites.owner_id` references is NOT inserted here.
  // Task 006's `databaseHooks.user.create.after` already created it as part of
  // the `createUser` above (see `./bootstrap-profile.ts`), and a second insert
  // is a duplicate-key violation on the primary key. Asserted rather than
  // assumed: if that hook is ever removed, this line fails with the reason
  // instead of the site insert failing on a foreign key.
  const [victimProfile] = await db
    .select({ id: schema.profiles.id })
    .from(schema.profiles)
    .where(eq(schema.profiles.id, victim.id));
  assert.equal(
    victimProfile?.id,
    victim.id,
    "profile bootstrap must have given the victim the owner row sites.owner_id points at",
  );

  // Kept, by the only definition of kept-ness: owner set, no clock.
  const inserted = await db
    .insert(schema.sites)
    .values({ slug: `e05-003-${runId}`, ownerId: victim.id, expiresAt: null })
    .returning({ id: schema.sites.id });
  const keptPageId = inserted[0]?.id;
  assert.ok(keptPageId, "the victim must actually hold a kept page for this drill to mean anything");
  createdSiteIds.push(keptPageId);

  // ── Control: the victim's row IS reachable by that email ───────────────────
  // Without this, the refusal below would prove nothing — a lookup that finds
  // nobody because nobody is there is not a policy.
  const verified = selectGithubIdentity(attackerProfile, [
    { email: victimEmail, primary: true, verified: true },
  ]);
  assert.equal(verified.emailVerified, true);
  const reachable = await internal.findOAuthUser(
    verified.email.toLowerCase(),
    attackerProfile.id.toString(),
    "github",
  );
  assert.equal(
    reachable?.user.id,
    victim.id,
    "a GitHub-VERIFIED address must resolve to the existing account — that is the link D2 allows",
  );

  // ── The attack: same address, GitHub says it is not verified ───────────────
  const refused = selectGithubIdentity(attackerProfile, [
    { email: victimEmail, primary: true, verified: false },
  ]);
  assert.equal(refused.emailVerified, false);

  const resolved = await internal.findOAuthUser(
    refused.email.toLowerCase(),
    attackerProfile.id.toString(),
    "github",
  );
  assert.equal(
    resolved,
    null,
    "an unverified provider email must not resolve to the existing account — no link, no session on it",
  );

  // ── And it is not a dead end: a DISTINCT account is created ────────────────
  const { user: attacker, account } = await internal.createOAuthUser(
    {
      email: refused.email,
      emailVerified: refused.emailVerified,
      name: attackerProfile.name ?? attackerProfile.login,
    },
    { providerId: "github", accountId: attackerProfile.id.toString() },
  );
  createdUserIds.push(attacker.id);

  assert.notEqual(attacker.id, victim.id, "the refusal must mint its own user row");
  assert.equal(account.userId, attacker.id, "its one account row belongs to it, not the victim");
  assert.notEqual(attacker.email, victim.email);

  // ── The asset: the victim's pages, not merely the victim's session ─────────
  const attackerPages = await db
    .select({ id: schema.sites.id })
    .from(schema.sites)
    .where(eq(schema.sites.ownerId, attacker.id));
  assert.deepEqual(attackerPages, [], "the refused account reaches NONE of the victim's kept pages");

  const victimPages = await db
    .select({ id: schema.sites.id })
    .from(schema.sites)
    .where(eq(schema.sites.ownerId, victim.id));
  assert.deepEqual(
    victimPages.map((page) => page.id),
    [keptPageId],
    "the victim's kept page is untouched and still theirs",
  );

  // No session was created anywhere in this flow for the victim.
  const victimSessions = await db
    .select({ id: schema.session.id })
    .from(schema.session)
    .where(eq(schema.session.userId, victim.id));
  assert.deepEqual(victimSessions, [], "no session was established on the existing account");
});
