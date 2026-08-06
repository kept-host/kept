/**
 * The gate for the whole `(app)` route group — E05 task 004.
 *
 * GATING THE GROUP LAYOUT IS THE POINT. Every route added under `(app)` — E06's
 * dashboard, site detail and settings — is gated the moment it exists, without
 * its page remembering to call anything. A page that had to opt in is a page
 * that can be shipped opted out.
 *
 * A SERVER-COMPONENT GATE, NOT MIDDLEWARE. `requireSession()` reads the same
 * session every other server component reads, from one place. Middleware runs
 * on the edge runtime and cannot open a Postgres connection, so a check there
 * would need a second, JWT-shaped source of truth or a fetch back into the app.
 * `middleware.ts` exists, but only to stamp the requested path onto the request
 * headers so the redirect below can carry a return URL; it performs no session
 * work and must not start.
 *
 * WHAT IS NOT GATED, AND MUST NOT BECOME GATED: the landing page,
 * `POST /api/publish`, `/p/[anonToken]` and `/keep/[anonToken]`. None of them is
 * in this group. Publish-before-signup is the product — an anonymous visitor
 * publishes, gets a live link, and only meets this gate if they choose to keep
 * the page forever.
 */
import { requireSession } from "@/lib/auth/session";

import { SignOutButton } from "./sign-out-button";

/**
 * Applies to every segment under `(app)`. A gated, per-user surface has no
 * prerenderable form — the answer depends on a cookie — and saying so here
 * keeps `next build` from trying to render `/dashboard` at build time, where
 * there is no request, no session, and (in CI) no auth environment at all.
 */
export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Redirects to `/auth?next=<the path that was requested>` when signed out.
  const session = await requireSession();

  return (
    <div className="min-h-dvh">
      <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
        <p className="mono-label text-text-muted">kept</p>
        <div className="flex items-center gap-3">
          <span className="text-sm text-text-secondary">{session.user.email}</span>
          <SignOutButton />
        </div>
      </header>
      {children}
    </div>
  );
}
