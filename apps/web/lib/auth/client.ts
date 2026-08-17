"use client";

/**
 * The browser's only auth surface — E05 task 004.
 *
 * ONE client instance, configured here and imported everywhere else. Task 005's
 * sign-in screen and any future settings screen import `signIn`, `signOut` and
 * `useSession` from this module and configure nothing themselves; a second
 * `createAuthClient` call elsewhere would be a second place for the base URL,
 * the plugin list and the fetch behaviour to drift.
 *
 * ── NO `baseURL` ON PURPOSE ────────────────────────────────────────────────
 * The client defaults to the origin it is running on plus `/api/auth`, which is
 * exactly where the handler is mounted (`app/api/auth/[...all]/route.ts`).
 * Pinning it to `NEXT_PUBLIC_APP_URL` instead would break every origin that is
 * not the one that variable happens to name — a preview deployment, a
 * non-default local port — by sending credentialed requests cross-origin. The
 * server half still resolves `authConfig().baseUrl`, because OAuth redirect
 * URIs are registered against one fixed origin; the browser half does not need
 * to know it.
 *
 * ── PLUGINS MIRROR THE SERVER ──────────────────────────────────────────────
 * `magicLinkClient()` is the client half of the `magicLink` plugin task 003
 * configured. The two lists must stay in step: a server plugin with no client
 * counterpart is simply unreachable from the browser. GitHub and Google need no
 * client plugin — `signIn.social({ provider })` is core.
 *
 * ⚠️ CLIENT MODULE. `"use client"` is load-bearing: it keeps this file (and the
 * nanostores it pulls in) out of the RSC graph, and it is why the server's
 * `getSession()` lives in `./session.ts` instead. A server component that needs
 * a session must not reach for `useSession`.
 */
import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [magicLinkClient()],
});

/**
 * The four the product actually uses:
 *  - `signIn.social({ provider: "github" | "google" })` — the two OAuth doors
 *  - `signIn.magicLink({ email, callbackURL })` — the third
 *  - `signOut()` — clears the session cookie and revokes the row
 *  - `useSession()` — reactive session for client chrome
 */
export const { signIn, signOut, useSession } = authClient;
