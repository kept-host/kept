/**
 * Profile bootstrap on first sign-in — E05 task 006.
 *
 * kept's half of a new account. Better Auth writes the `user` row; this writes
 * the `profiles` row that `sites.owner_id` actually points at.
 *
 * ── WHY A DATABASE HOOK AND NOT THE CALLBACK ROUTE ─────────────────────────
 * `databaseHooks.user.create.after` fires on the one event that defines "first
 * sign-in" — the `user` row coming into existence — regardless of which door it
 * came through. GitHub's callback, Google's callback and the magic-link verify
 * endpoint all reach `internalAdapter.createUser`/`createOAuthUser`, and so will
 * any door a later epic adds, without that door remembering to call anything.
 * Wiring this into the three callbacks instead would mean a fourth door silently
 * producing a signed-in user with no profile, which surfaces much later as a
 * failed keep.
 *
 * Two properties of the hook that this design depends on, both verified against
 * better-auth 1.6.26's `getWithHooks`:
 *   1. `create.after` is **awaited** (`for (const hook of pendingHooks) await
 *      hook()`), and a throw propagates out of the sign-in request. A profile
 *      that fails to insert therefore fails the sign-in loudly instead of
 *      producing a half-made account nobody notices.
 *   2. For the OAuth path the hook is queued through
 *      `queueAfterTransactionHook` and runs **after the transaction commits**,
 *      so the `user` row is visible to this connection. That is what makes the
 *      `profiles.id → user.id` FK satisfiable; running inside the transaction on
 *      a different connection would deadlock or violate it.
 *
 * ── WHAT THE HOOK WRITES ───────────────────────────────────────────────────
 * The email and a freshly minted referral code, nothing else. The handle starts
 * `null` (E10 D9, AC14): it is a name in the page namespace that the user
 * chooses, not something derived from a provider's display name, and the
 * display name itself stays on Better Auth's `user.name`.
 */
import { ensureProfile } from "../db/queries/profile";

/**
 * Create this user's profile. Called once per user by the hook below; safe to
 * call again (the underlying upsert is `ON CONFLICT DO NOTHING`), which is what
 * makes a replayed OAuth callback harmless rather than a unique violation in
 * the user's face.
 */
export async function bootstrapProfile(user: {
  id: string;
  email?: string | null;
}): Promise<void> {
  await ensureProfile({
    userId: user.id,
    email: user.email ?? null,
  });
}
