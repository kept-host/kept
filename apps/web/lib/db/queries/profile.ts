/**
 * Session → profile, and the create-once that makes it total — E05 task 006.
 *
 * Better Auth owns the `user` row. kept owns the `profiles` row (`handle`,
 * `email`, `plan`), and `sites.owner_id` is an FK onto **that**. Every caller
 * that needs an owner id — task 008's keep, task 010's owner routes, E06's
 * dashboard — resolves it here. There is deliberately no second way to get from
 * a session to a profile: two resolutions would eventually disagree about what
 * happens when the row is missing, which is exactly the case that decides
 * whether a page ends up owned or orphaned.
 *
 * ── THE IDENTITY KEY IS `profiles.id = user.id` ────────────────────────────
 * Task 002's decision (D1), already in `lib/db/schema.ts`: `profiles.id` is a
 * `uuid` PRIMARY KEY that REFERENCES `user.id` and — deliberately — has **no**
 * `defaultRandom()`, because a random default could never satisfy that FK. So
 * the id is never generated here; it is always the auth user's id, and the
 * conflict target for the create-once below is the primary key itself.
 *
 * ── WHY `ON CONFLICT DO NOTHING`, NOT `SELECT` THEN `INSERT` ───────────────
 * An OAuth callback is a redirect the browser can and does replay: a
 * double-clicked consent button, a refresh mid-callback, a client retry. Two
 * near-simultaneous first sign-ins would both see "no profile" and both insert.
 * `insert … on conflict do nothing` followed by a read collapses that race into
 * one row, in the database, without an advisory lock or a retry loop.
 *
 * `DO NOTHING` — never `DO UPDATE`. The upsert is also what guarantees the
 * handle-seeding rule below: a second sign-in, through a second provider, must
 * not overwrite a handle the user already has, and E06 lets the user edit it,
 * which a re-seed would silently undo.
 */
import type { Plan } from "@kept/shared";
import { eq } from "drizzle-orm";

import { db, schema } from "..";

/**
 * A kept profile as this module returns it — the Drizzle row, so a schema change
 * is a type error at the call site rather than a silent divergence. (Not
 * `@kept/shared`'s `Profile`, whose timestamps are ISO strings for the wire.)
 */
export type ProfileRow = typeof schema.profiles.$inferSelect;

/** Every profile starts free. `premium` is E11's to grant. */
const INITIAL_PLAN: Plan = "free";

/**
 * The display handle to seed at creation, or `null`.
 *
 * PROVIDER-AGNOSTIC BY CONSTRUCTION. There is no `github_handle` column and
 * none is coming (epic decision): provider identities live in Better Auth's
 * `account` table, which is the only place they stay correct across link and
 * unlink. What reaches us is the one field every door fills in the same way —
 * `user.name`:
 *
 *   - github — `profile.name || profile.login`, mapped in `lib/auth/index.ts`'s
 *     `getUserInfo`. A GitHub user with no display name seeds their `login`.
 *   - google — the profile name from the id token.
 *   - magic link — Better Auth's plugin creates the user with `name: name || ""`
 *     and kept's sign-in form asks for an email and nothing else, so this is the
 *     empty string and the handle is **null**.
 *
 * NULL IS A COMPLETE STATE, NOT A GAP. A magic-link user genuinely has no
 * provider handle; synthesising one ("user-8f3c") would put a fake identifier in
 * front of them that they never chose. `handle` is presentation only — it is not
 * unique, has no unique index, and nothing resolves by it.
 */
export function seedHandle(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Create the profile for an auth user if it does not exist, and return it.
 *
 * Idempotent and safe under concurrency: N simultaneous callers produce exactly
 * one row, and every one of them returns it. `handle` and `email` are applied
 * **at creation only** — on an existing row this is a read.
 */
export async function ensureProfile(input: {
  /** The Better Auth `user.id`. Becomes `profiles.id` unchanged (D1). */
  userId: string;
  /** The email on the auth user; already lowercased by Better Auth. */
  email: string | null;
  /** Seed from `seedHandle(user.name)`. `null` is valid and final. */
  handle: string | null;
}): Promise<ProfileRow> {
  await db
    .insert(schema.profiles)
    .values({
      id: input.userId,
      email: input.email,
      handle: input.handle,
      plan: INITIAL_PLAN,
    })
    .onConflictDoNothing({ target: schema.profiles.id });

  const [profile] = await db
    .select()
    .from(schema.profiles)
    .where(eq(schema.profiles.id, input.userId));

  if (!profile) {
    // Unreachable unless the row was deleted between the insert and the read —
    // which means the auth user was deleted too (the FK cascades). Throwing is
    // right: the alternative is handing a caller `undefined` and letting it
    // write `sites.owner_id = null`, silently un-owning a page.
    throw new Error(`Profile missing for auth user ${input.userId} immediately after upsert`);
  }
  return profile;
}

/**
 * The profile behind a session, or `null` when nobody is signed in.
 *
 * Takes the session rather than reading it, so this module stays importable
 * outside a request scope (`lib/auth/session.ts` imports `next/headers`, which
 * throws anywhere else — including in `tsx --test`). Callers pass what they
 * already hold:
 *
 *     const profile = await getProfileForSession(await getSession());
 *
 * IT BOOTSTRAPS, IT DOES NOT MERELY LOOK UP. Normally the profile already
 * exists — `databaseHooks.user.create.after` made it on first sign-in (see
 * `lib/auth/bootstrap-profile.ts`). This is the backstop for the accounts that
 * hook never ran for: users created before this task landed, and any future
 * sign-up path added outside Better Auth. The alternative is a signed-in user
 * whose keep fails with "no profile", which is not a state the product has copy
 * for. The same `ON CONFLICT DO NOTHING` makes the backstop free of races, and
 * the common path stays a single indexed read.
 */
export async function getProfileForSession(
  session: {
    user: { id: string; email?: string | null; name?: string | null };
  } | null,
): Promise<ProfileRow | null> {
  if (!session) return null;

  const [existing] = await db
    .select()
    .from(schema.profiles)
    .where(eq(schema.profiles.id, session.user.id));
  if (existing) return existing;

  return ensureProfile({
    userId: session.user.id,
    email: session.user.email ?? null,
    handle: seedHandle(session.user.name),
  });
}
