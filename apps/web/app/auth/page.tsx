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
import Link from "next/link";

import { RETURN_PARAM, safeReturnPath } from "@/lib/auth/return-path";

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
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-[1100px] items-center px-8">
          <Link
            href="/"
            className="rounded-[var(--r-sm)] font-display text-[1.375rem] font-bold tracking-[-0.03em] text-text outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            kept
          </Link>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-[420px]">
          {/* The vessel. Its geometry and gradients are `.kept-vessel` in
              globals.css — see the block there for why they cannot be Tailwind
              arbitrary values. The glowing core stays here: it is a plain
              circle and expresses fine as classes. */}
          <div
            aria-hidden="true"
            className="mb-2 flex h-24 items-center justify-center"
          >
            <div className="kept-vessel relative">
              <div className="absolute left-1/2 top-[54%] size-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,var(--accent-hover),var(--accent)_60%)] shadow-[0_0_22px_6px_color-mix(in_srgb,var(--accent)_45%,transparent)]" />
            </div>
          </div>

          <SignInForm
            returnTo={safeReturnPath(firstValue(params[RETURN_PARAM]))}
            initialErrorCode={firstValue(params.error) ?? null}
          />
        </div>
      </main>
    </div>
  );
}
