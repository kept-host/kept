/**
 * Session → profile, and the create-once that makes it total — E05 task 006.
 *
 * Better Auth owns the `user` row. kept owns the `profiles` row (`email`,
 * `plan`, `referral_code`, and E10's `handle` and profile fields), and `sites.owner_id` is an FK onto **that**. Every caller
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
 * `DO NOTHING` — never `DO UPDATE`. A second sign-in, through a second
 * provider, must not overwrite the email or mint a second referral code: a code
 * is permanent once shared (E10 Q3).
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

/** Inserts tried before `ensureProfile` gives up (see below). */
const MAX_INSERT_ATTEMPTS = 5;

/**
 * Create the profile for an auth user if it does not exist, and return it.
 *
 * Idempotent and safe under concurrency: N simultaneous callers produce exactly
 * one row, and every one of them returns it. `email`, and the `referral_code`
 * the database mints, are set **at creation only** — on an existing row this is
 * a read. `handle` is never written here: it starts `null` and only the owner
 * sets it (E10 D9).
 *
 * The untargeted `ON CONFLICT DO NOTHING` absorbs both the replayed-callback
 * race on the primary key and a referral-code collision. Only the second leaves
 * no row behind, so an empty read means "insert again for a fresh code" —
 * 16^8 codes make even one retry rare.
 */
export async function ensureProfile(input: {
  /** The Better Auth `user.id`. Becomes `profiles.id` unchanged (D1). */
  userId: string;
  /** The email on the auth user; already lowercased by Better Auth. */
  email: string | null;
}): Promise<ProfileRow> {
  for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS; attempt++) {
    await db
      .insert(schema.profiles)
      .values({
        id: input.userId,
        email: input.email,
        plan: INITIAL_PLAN,
      })
      .onConflictDoNothing();

    const [profile] = await db
      .select()
      .from(schema.profiles)
      .where(eq(schema.profiles.id, input.userId));
    if (profile) return profile;
  }
  // A missing row after every attempt means the auth user was deleted under us
  // (the FK cascades) or the code generator is broken. Throwing is right: the
  // alternative is handing a caller `undefined` and letting it write
  // `sites.owner_id = null`, silently un-owning a page.
  throw new Error(
    `Profile missing for auth user ${input.userId} after ${MAX_INSERT_ATTEMPTS} upserts`,
  );
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
    user: { id: string; email?: string | null };
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
  });
}
