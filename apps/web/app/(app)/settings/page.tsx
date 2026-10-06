/**
 * `(app)/settings` — PRD §5.8 and §9.3, from `kept Settings Screen.dc.html`.
 * E06 task 012 built it; task 013 imported the design.
 *
 * Four sections: Account (the email, sign-in methods, sign out), Plan (badge,
 * usage meters, the Pro list on Free), Your data (the streamed export) and
 * Danger zone (delete the account). The design's Handle, Own domain, Referrals
 * and display-name field belong to later epics and are not in the tree (AC10).
 *
 * Every read happens here, in the server component; every write is a call from
 * a client island — Better Auth's own endpoints for link / unlink / sign out,
 * the studio routes for export and deletion. No server actions: that would be a
 * second CSRF model on a route E05a already origin-gates.
 *
 * ── NO SECOND GATE ───────────────────────────────────────────────────────────
 * `(app)/layout.tsx` gates the whole group, so this file resolves *which*
 * account is looking and does not re-ask *whether* anyone is.
 *
 * ── ⚠️ NO THEME CONTROL, AND ITS ABSENCE IS THE DECISION ─────────────────────
 * Not a working one and not a locked or disabled row either. `providers.tsx`
 * pins `forcedTheme="light"`, and unforcing it breaks the landing (CLAUDE.md).
 * A greyed-out row would advertise a switch and invite deleting `forcedTheme`.
 * Every surface here still paints from tokens, so dark is correct the day it is
 * switched on.
 */
import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/session";
import { getLinkedProviders } from "@/lib/db/queries/account";
import { getProfileForSession } from "@/lib/db/queries/profile";
import { chosenNameCount } from "@/lib/names/check";
import { farewellHref } from "@/lib/routing/host-split";
import { getAccountDeletionSummary } from "@/lib/sites/account-deletion";
import { keptQuotaFor } from "@/lib/sites/keep";

import { SignOutButton } from "../sign-out-button";
import { Wordmark } from "../wordmark";
import { DeleteAccount } from "./delete-account";
import { ExportPanel } from "./export-panel";
import { LinkProviders } from "./link-providers";
import { PlanPanel } from "./plan-panel";
import { SettingsCard } from "./settings-card";
import { SettingsSections } from "./settings-sections";

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
   * (`errorCallbackURL`), and `?linked=` is where a successful one lands. Read
   * here and handed down, so the client island never parses the URL itself.
   */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  const profile = await getProfileForSession(session);
  if (!session || !profile) {
    // Unreachable past the group layout unless the profile bootstrap itself
    // failed. An empty settings screen would show a real account no providers
    // and a deletion list claiming it owns nothing, so bounce instead.
    redirect("/auth?next=%2Fsettings");
  }

  const [linked, deletion, kept, names, params] = await Promise.all([
    getLinkedProviders(profile.id),
    // The counts the deletion list states, read at render time from the same
    // predicates the cap and the Pages home count with. It is also the export's
    // page count: `total === 0` is "Nothing to export yet."
    getAccountDeletionSummary(profile.id),
    keptQuotaFor(profile.id),
    chosenNameCount(profile.id),
    searchParams,
  ]);

  const first = (value: string | string[] | undefined): string | null =>
    Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

  return (
    <>
      {/* The phone's top bar; on desktop the sidebar carries the wordmark. */}
      <header className="flex h-16 items-center border-b border-border px-4 md:hidden">
        <Wordmark className="text-[22px]" />
      </header>

      <main className="flex max-w-[1040px] flex-col gap-6 px-4 pb-24 pt-8 @container md:px-10">
        <h1 className="font-display text-[clamp(32px,6cqw,40px)] font-bold leading-[1.1] tracking-[-0.03em] text-text">
          Settings
        </h1>

        <SettingsSections
          sections={[
            {
              id: "account",
              label: "Account",
              content: (
                <>
                  <SettingsCard title="Account">
                    <div className="flex flex-col gap-1.5">
                      <span className="text-sm font-medium text-text">Email</span>
                      <span
                        data-testid="account-email"
                        className="flex min-h-11 items-center break-all rounded-[var(--r-sm)] border border-border bg-sunken px-3 py-2 text-[15px] text-text"
                      >
                        {session.user.email}
                      </span>
                    </div>
                    <SignOutButton />
                  </SettingsCard>
                  <LinkProviders
                    email={session.user.email}
                    linked={linked.map((provider) => ({
                      providerId: provider.providerId,
                      accountId: provider.accountId,
                      linkedAt: provider.linkedAt.toISOString(),
                    }))}
                    justLinked={first(params.linked)}
                    initialErrorCode={first(params.error)}
                  />
                </>
              ),
            },
            {
              id: "plan",
              label: "Plan",
              content: <PlanPanel plan={profile.plan} kept={kept} names={names} />,
            },
            {
              id: "data",
              label: "Your data",
              content: <ExportPanel empty={deletion.total === 0} />,
            },
            {
              id: "danger",
              label: "Danger zone",
              content: (
                <DeleteAccount
                  summary={deletion}
                  email={session.user.email}
                  farewellHref={farewellHref(process.env.NEXT_PUBLIC_APP_URL)}
                />
              ),
            },
          ]}
        />
      </main>
    </>
  );
}
