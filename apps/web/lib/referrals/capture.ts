/**
 * Recording a referral at sign-up (E10 D11, Q20, AC17) — called from Better
 * Auth's `databaseHooks.user` in `lib/auth/index.ts`, beside the profile
 * bootstrap.
 *
 * ── WHERE THE HOOK FINDS `ref` (verified on better-auth 1.6.26) ──────────────
 * `create.after` receives the endpoint context that created the user:
 *   · magic link — `/magic-link/verify?token=…&callbackURL=…`: the callback
 *     URL is on `ctx.query`;
 *   · OAuth — `/callback/:provider`: the callback URL is in the parsed OAuth
 *     state, which Better Auth keeps in request state (`getOAuthState()`).
 * Either way it is the `next` path the sign-in form sent, and `ref` rides in
 * its query (`./ref.ts`). So the hook sees it, and no "first app request"
 * fallback is needed.
 *
 * ── THE RULES ────────────────────────────────────────────────────────────────
 * A NEW account only (`create.after` fires once per user), one referrer per
 * account (the primary key — the first wins), never yourself, never an unknown
 * code. A referral counts once the new account's email is verified: at once for
 * a magic link or a verified OAuth address, else on the update that verifies it
 * (`verifySignUpReferral`).
 *
 * Never throws and never logs an email: a referral is an optional feature, and
 * a sign-in must not fail because one could not be recorded.
 */
import { getOAuthState } from "better-auth/api";

import { resolveRefCode } from "../db/queries/handles";
import { insertReferral, markReferralVerified } from "../db/queries/referrals";

import { refFromPath } from "./ref";

export type ReferralCapture = "recorded" | "self" | "duplicate" | "unknown" | "none";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The `ref` the sign-up carried, from the hook's endpoint context, or `null`.
 * `ctx` is Better Auth's `GenericEndpointContext` (or `null` outside an
 * endpoint); only its `query` is read.
 */
export async function signUpRef(ctx: { query?: unknown } | null | undefined): Promise<string | null> {
  const query = ctx?.query as Record<string, unknown> | undefined;
  if (typeof query?.callbackURL === "string") return refFromPath(decoded(query.callbackURL));
  // Outside an OAuth callback there is no request state, and the read throws.
  const state = await getOAuthState().catch(() => null);
  return refFromPath(typeof state?.callbackURL === "string" ? state.callbackURL : null);
}

/**
 * Credit `ref`'s account with the new account `user`. Resolves `ref` as a
 * current handle, an old handle, then a referral code (Q3).
 */
export async function recordSignUpReferral(
  user: { id: string; emailVerified?: boolean | null },
  ref: string | null,
): Promise<ReferralCapture> {
  if (!ref) return "none";
  try {
    const referrerId = await resolveRefCode(ref);
    if (!referrerId) return "unknown";
    if (referrerId === user.id) return "self";
    const inserted = await insertReferral({
      referrerId,
      referredId: user.id,
      verified: user.emailVerified === true,
    });
    return inserted ? "recorded" : "duplicate";
  } catch (err) {
    console.error(`[kept] referral for user ${user.id} not recorded — ${message(err)}`);
    return "none";
  }
}

/** The user row was updated: once its email is verified, its referral counts. */
export async function verifySignUpReferral(user: { id: string; emailVerified?: boolean | null }): Promise<void> {
  if (user.emailVerified !== true) return;
  try {
    await markReferralVerified(user.id);
  } catch (err) {
    console.error(`[kept] referral for user ${user.id} not marked verified — ${message(err)}`);
  }
}
