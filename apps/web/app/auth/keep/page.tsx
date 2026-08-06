/**
 * `/auth/keep` — sign in, mid-keep. E05 task 009.
 *
 * The same screen as `/auth`, with two differences and no third: task 005's
 * `keepNotice` slot is filled, and `returnTo` is pinned to `KEEP_RESUME_PATH`
 * so every provider — GitHub, Google, magic link — comes back to the one place
 * that resumes the keep.
 *
 * ── WHY THIS IS A PAGE AND NOT A ROUTE HANDLER ─────────────────────────────
 * The task sketched `app/auth/keep/route.ts` setting the cookie and forwarding
 * to `/auth`. That forward is a redirect nobody needs: this route can *be* the
 * sign-in screen. The cookie is written a step earlier, by
 * `app/keep/[anonToken]/start-keep.ts` — a server action, which is one of the
 * two places Next.js permits a cookie write and is where the token already is,
 * so the token never travels to reach its writer. The same action sends an
 * already-signed-in visitor straight to the outcome and never here, so "skip
 * sign-in entirely" is satisfied before this file is reached rather than after.
 *
 * ── NOTHING HERE READS THE COOKIE, OR THE SESSION ──────────────────────────
 * Not the notice, not the return path, not a branch. `app/auth/callback/route.ts`
 * is the single reader; this screen is chrome around task 005's island and would
 * render identically with no cookie at all. There is deliberately no
 * "already signed in, redirect on" check either — a page component is rendered
 * by the router more than once per navigation, so a redirect here would fire on
 * a prefetch as well as the navigation and spend the intent twice.
 */
import type { Metadata } from "next";

import { KEEP_RESUME_PATH } from "@/lib/auth/pending-keep";

import { AuthShell } from "../auth-shell";
import { SignInForm } from "../sign-in-form";

export const metadata: Metadata = {
  title: "Keep this page",
  description: "Sign in to keep this page forever.",
  // Mid-flow, and reached from a screen whose URL is a bearer credential.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * The exact line task 005 left the slot for. It answers the only question a
 * stranger has at this point — *what happens to my page while I do this?* —
 * and the answer is "nothing": keeping moves no files and changes no address.
 */
const KEEP_NOTICE =
  "We'll attach this page to your account — it stays exactly where it is.";

export default function KeepSignInPage() {
  return (
    <AuthShell>
      <SignInForm returnTo={KEEP_RESUME_PATH} keepNotice={KEEP_NOTICE} />
    </AuthShell>
  );
}
