/**
 * `/auth` — the sign-in screen. E05 task 005.
 *
 * Replaces the E00 placeholder, whose visible copy told real visitors that
 * sign-in was coming in a since-renamed epic — on a page the `(app)` gate sends
 * people to. The task's acceptance criterion is that the string is gone from
 * the repo, so it is not quoted here either.
 *
 * ── A SHELL WITH NO DEPENDENCIES ───────────────────────────────────────────
 * This component reads two query parameters and renders chrome. It touches no
 * database, constructs no auth instance and awaits nothing but `searchParams`,
 * which is what lets the sign-in page render when the thing being signed into
 * is unhappy. The session read, all three routes and every state live in the
 * client island (`./sign-in-form.tsx`); the reasoning is written up there.
 *
 * ── THE TWO PARAMETERS ─────────────────────────────────────────────────────
 * `?next=` is where a gated visit resumes, written by `requireSession()` and
 * validated here by `safeReturnPath` — **the validation happens on the read
 * side because the value arrives from the address bar**, and an unchecked one
 * turns this page into an open redirect. `?error=` is how a bounced round trip
 * (a declined consent, a refused account link, a spent magic link) reports what
 * went wrong; the island turns the code into a sentence.
 *
 * The pending-keep token is NOT here and must never be: it travels as an
 * httpOnly cookie (task 009), because a bearer credential in a query parameter
 * would undo E04's posture.
 */
import type { Metadata } from "next";

import { RETURN_PARAM, safeReturnPath } from "@/lib/auth/return-path";

import { AuthShell } from "./auth-shell";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to kept to keep your pages forever.",
  // A sign-in form is not a search result, and `?next=` / `?error=` would be
  // indexed along with it.
  robots: { index: false, follow: false },
};

/** First value only: `?next=a&next=b` is a probe, not a user. */
function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AuthPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  return (
    <AuthShell>
      <SignInForm
        returnTo={safeReturnPath(firstValue(params[RETURN_PARAM]))}
        initialErrorCode={firstValue(params.error) ?? null}
      />
    </AuthShell>
  );
}
