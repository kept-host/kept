/**
 * The gate and the shell for the whole `(app)` route group — E05 task 004
 * (the gate), E06 task 011 (the studio shell).
 *
 * GATING THE GROUP LAYOUT IS THE POINT. Every route added under `(app)` — the
 * Pages home, page detail and settings — is gated the moment it exists, without
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
 * in this group. Publish-before-signup is the product.
 *
 * ── THE SHELL (`kept Studio Screen.dc.html`) ─────────────────────────────────
 * Desktop: a sidebar with the wordmark, the nav, the plan card and the avatar
 * menu. Phone: a bottom tab bar with the same nav and the avatar menu. Each
 * screen owns its own top bar. The nav is Pages and Settings ONLY (AC10) — see
 * `./studio-nav.tsx`. The plan card shows the plan and the kept allowance, from
 * the same `keptQuotaFor` the cap enforces with; the design's "Apply for
 * Founding" is E11's and is not rendered. Tasks 012 and 013 mount inside this
 * shell and do not edit it.
 */
import { PlanBadge } from "@/components/kept/plan-badge";
import { requireSession } from "@/lib/auth/session";
import { getProfileForSession } from "@/lib/db/queries/profile";
import { keptQuotaFor } from "@/lib/sites/keep";

import { AccountMenu } from "./account-menu";
import { StudioNav } from "./studio-nav";
import { Wordmark } from "./wordmark";

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
  const profile = await getProfileForSession(session);
  if (!profile) {
    // Unreachable past `requireSession` unless the profile bootstrap failed.
    // Throwing lands on the nearest error boundary, which offers a retry.
    throw new Error("Signed in, but no profile resolved for the session.");
  }
  const quota = await keptQuotaFor(profile.id);

  const account = {
    name: session.user.name ?? "",
    email: session.user.email,
    plan: profile.plan,
  };

  return (
    <div className="min-h-dvh md:flex">
      <aside className="sticky top-0 hidden h-dvh w-[232px] shrink-0 flex-col gap-7 border-r border-border px-3 pb-4 pt-5 md:flex">
        <Wordmark className="px-3 py-1 text-[26px]" />
        <StudioNav variant="sidebar" />

        <div className="mt-auto flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2 rounded-[var(--r-md)] border border-border bg-surface p-3">
            <PlanBadge plan={profile.plan} />
            <span className="font-mono text-xs font-medium tracking-[0.08em] text-text-secondary">
              {quota.used} / {quota.limit}
            </span>
          </div>
          <AccountMenu variant="sidebar" {...account} />
        </div>
      </aside>

      <div className="min-w-0 flex-1 pb-[88px] md:pb-0">{children}</div>

      {/* `data-tab-bar`: toasts rise above it on a phone (`globals.css`). */}
      <div
        data-tab-bar=""
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t border-border bg-surface px-1 pb-5 pt-1 md:hidden"
      >
        <StudioNav variant="tabs" />
        <AccountMenu variant="tabs" {...account} />
      </div>
    </div>
  );
}
