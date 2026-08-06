"use server";

/**
 * "Keep it forever", pressed — E05 task 009.
 *
 * A server action rather than a route handler, for three reasons that all point
 * the same way:
 *
 *   1. **The token never travels.** It is closed over by the inline action in
 *      `./page.tsx` when the screen renders, so it goes into no URL, no query
 *      string and no visible form field — Next encrypts the closed-over
 *      variables of an inline server action before they reach the document.
 *      (`.bind()` does NOT: its arguments are serialised into a plaintext hidden
 *      field, which the no-JS spec in `e2e/anon-screens.spec.ts` asserts against.)
 *      A `POST /auth/keep` with the token in the body would work too, but only
 *      after rendering it into the markup first.
 *   2. **CSRF is already handled.** Next verifies `Origin` against `Host` on
 *      every server action; a hand-rolled route handler would have to restate
 *      that check, and forgetting it would let a cross-site form plant somebody
 *      else's page in a visitor's pending-keep slot.
 *   3. **It runs exactly once per submit.** A page component does not: the
 *      router renders it for a prefetch and again for the navigation, and either
 *      extra render would be another keep attempt against a token the first one
 *      already spent. That is why the branch below lives here and not in
 *      `/auth/keep`.
 *
 * It also works with JavaScript off: `<form action={…}>` posts to the action and
 * follows the redirect natively, which the claim screen's no-JS spec asserts —
 * that screen carries zero client behaviour and this must not change it.
 *
 * ── TWO PATHS, AND THE SHORT ONE HAS NO COOKIE AT ALL ──────────────────────
 * The pending-keep cookie exists to survive a round trip through a third party.
 * A visitor who is already signed in is taking no round trip, so they take no
 * cookie: the keep happens here, in the request that pressed the button, and
 * they land on the same result screen the resumed path lands on. Fewer places
 * the bearer token is written, one fewer redirect, and the same four outcomes —
 * `./done/outcomes.ts` maps them for both callers.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { doneHrefForKeep } from "@/app/auth/callback/done/outcomes";
import { isAnonTokenShaped, pendingKeepCookie } from "@/lib/auth/pending-keep";
import { getSession } from "@/lib/auth/session";
import { getProfileForSession } from "@/lib/db/queries/profile";
import { keepAnonymousPage } from "@/lib/sites/anon-keep";
import { notFound } from "@/lib/publish/anon-token";

/** Where a visitor who still has to sign in is sent. */
const KEEP_SIGN_IN_PATH = "/auth/keep";

export async function startKeep(anonToken: string): Promise<void> {
  // A malformed token can only come from a tampered payload — the real one was
  // bound on the server. It is still carried through rather than rejected here:
  // every bad token resolves to the same friendly, indistinguishable answer, and
  // a distinct failure at this step would be an oracle for token shape.
  const token = isAnonTokenShaped(anonToken) ? anonToken : null;

  const profile = await getProfileForSession(await getSession());

  if (!profile) {
    // Signed out: park the intent and hand them to sign-in. `/auth/callback`
    // spends the cookie exactly once when they come back.
    if (token) (await cookies()).set(pendingKeepCookie(token));
    redirect(KEEP_SIGN_IN_PATH);
  }

  // `redirect()` throws, so nothing after either branch runs.
  redirect(
    doneHrefForKeep(
      token ? await keepAnonymousPage(token, profile.id) : notFound(),
    ),
  );
}
