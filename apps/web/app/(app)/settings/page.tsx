/**
 * `(app)/settings` — who you are, what you pay, and the one door out.
 * E06 task 012.
 *
 * ── THREE PANELS AND ONE DANGEROUS BUTTON ────────────────────────────────────
 * Account (email + the providers that can sign you in), Plan (Free, with Pro
 * locked), and the account teardown. Everything on the screen is a read here in
 * the server component; every write is a `fetch` from one of the three client
 * islands below. No server actions — that would be a second CSRF model on a
 * route E05a already origin-gates.
 *
 * ── NO SECOND GATE ───────────────────────────────────────────────────────────
 * `(app)/layout.tsx` gates the whole group, so this file resolves *which*
 * account is looking and does not re-ask *whether* anyone is. A page that
 * re-gated itself is a page that can ship opted out.
 *
 * ── ⚠️ NO THEME CONTROL, AND ITS ABSENCE IS THE DECISION (epic D4) ───────────
 * The PRD lists a theme preference. There is none here — not a working one, and
 * deliberately **not a locked or disabled "Theme" row either**. `providers.tsx`
 * pins `forcedTheme="light"`, `layout.tsx` stamps `data-theme="light"`,
 * `setTheme` is called nowhere in the repo, and `KeptLanding.tsx` carries ~81
 * hardcoded colour literals building a light→dark→light band rhythm, so
 * unforcing the theme makes the landing unreadable. Making dark real is an epic,
 * not a settings row. A greyed-out row would be worse than nothing: it advertises
 * a switch, and the obvious "fix" it invites is deleting `forcedTheme`, which is
 * the exact change CLAUDE.md exists to prevent. **The settings screen does not
 * show a control that does nothing.** Every surface here still paints from
 * tokens so dark is correct on the day it is switched on.
 *
 * ── DESIGNED FROM TOKENS, NOT IMPORTED ───────────────────────────────────────
 * `kept Settings.dc.html` was not available to this task (the `claude_design`
 * connector is unauthorized), so the screen is composed from `globals.css`'s
 * tokens in the house language the dashboard and site-detail screens established
 * — editorial display type, hairline rules, mono meta-labels, warm canvas. A
 * reconciliation pass against the export is a known follow-up.
 */
import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/session";
import { getLinkedProviders } from "@/lib/db/queries/account";
import { getProfileForSession } from "@/lib/db/queries/profile";
import { farewellHref } from "@/lib/routing/host-split";
import { getAccountDeletionSummary } from "@/lib/sites/account-deletion";

import { DeleteAccount } from "./delete-account";
import { LinkProviders } from "./link-providers";
import { PlanPanel } from "./plan-panel";

/** Session-shaped and per-user; there is no prerenderable form of this page. */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Settings · kept",
};

export default async function SettingsPage({
  searchParams,
}: {
  /**
   * `?error=` is where Better Auth's OAuth callback lands a refused **link**
   * (`errorCallbackURL`), and `?linked=` is where a successful one lands. Both
   * are read here and handed down as props, exactly as `/auth` does it, so the
   * client island never parses the URL itself.
   */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  const profile = await getProfileForSession(session);
  if (!session || !profile) {
    // Unreachable past the group layout unless the profile bootstrap itself
    // failed. Rendering an empty settings screen would show a real account no
    // providers and a deletion dialog claiming it owns nothing, so bounce
    // instead — the gate will send them back here once there is a session.
    redirect("/auth?next=%2Fsettings");
  }

  const [linked, deletion, params] = await Promise.all([
    getLinkedProviders(profile.id),
    // D3: the counts the dialog states are read HERE, at render time, from the
    // same predicate the quota is counted with. Never a generic warning, never a
    // number typed into copy.
    getAccountDeletionSummary(profile.id),
    searchParams,
  ]);

  const first = (value: string | string[] | undefined): string | null =>
    Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

  return (
    <main className="mx-auto w-full max-w-[52rem] px-6 pb-28 pt-12 md:px-8 md:pt-16">
      <header className="border-b border-border pb-8">
        <p className="mono-label text-[11px] text-text-muted">Settings</p>
        <h1 className="mt-3 font-display text-[clamp(2.1rem,5.5vw,3.1rem)] font-bold text-text">
          Your account
        </h1>
        <p className="mt-4 max-w-[58ch] leading-relaxed text-text-secondary">
          How you sign in, what your plan includes, and how to leave. Your pages
          themselves live on the dashboard.
        </p>
      </header>

      <div className="mt-12 flex flex-col gap-6">
        <LinkProviders
          email={session.user.email}
          emailVerified={session.user.emailVerified}
          linked={linked.map((provider) => ({
            providerId: provider.providerId,
            accountId: provider.accountId,
            linkedAt: provider.linkedAt.toISOString(),
          }))}
          justLinked={first(params.linked)}
          initialErrorCode={first(params.error)}
        />

        <PlanPanel plan={profile.plan} />

        <DeleteAccount summary={deletion} farewellHref={farewellHref(process.env.NEXT_PUBLIC_APP_URL)} />
      </div>
    </main>
  );
}
