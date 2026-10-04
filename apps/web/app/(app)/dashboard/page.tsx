/**
 * `(app)/dashboard` — the Pages home. E06 task 011 (PRD §5.1, §9.1).
 *
 * A READ, STRAIGHT TO POSTGRES. `getDashboardSites` is one round trip: the
 * owner's kept pages and drafts, the kept allowance from the same predicate the
 * cap enforces with, the chosen-names count, and each page's recent visits with
 * the sync's "as of". No fetch to this app's own API, no server action, and no
 * second gate — `(app)/layout.tsx` gates every route in the group. Every
 * mutation is the client's, through the owner routes, followed by
 * `router.refresh()`, which re-runs this.
 *
 * `ClockProvider` gets the server's `Date.now()` so the drafts' countdowns
 * render identically on the server and on first paint, then tick client-side.
 */
import { getSession } from "@/lib/auth/session";
import { getDashboardSites, type DashboardSite } from "@/lib/db/queries/dashboard";
import { getProfileForSession } from "@/lib/db/queries/profile";
import { liveUrl } from "@/lib/publish/pipeline";

import { ClockProvider } from "./clock";
import type { HomeSite } from "./home-card";
import { PagesHome } from "./pages-home";

function withLiveUrl(site: DashboardSite): HomeSite {
  return { ...site, liveUrl: liveUrl(site.slug) };
}

export default async function DashboardPage() {
  const profile = await getProfileForSession(await getSession());
  if (!profile) {
    // Unreachable past the layout unless the profile bootstrap itself failed.
    // Rendering the empty state would tell somebody with pages that they have
    // none, so this lands on `./error.tsx`, which offers a retry.
    throw new Error("Signed in, but no profile resolved for the session.");
  }

  const home = await getDashboardSites(profile.id);

  return (
    <ClockProvider initialNow={Date.now()}>
      <PagesHome
        kept={home.kept.map(withLiveUrl)}
        drafts={home.drafts.map(withLiveUrl)}
        quota={home.quota}
        names={home.names}
        plan={profile.plan}
        visitsAsOf={home.visitsAsOf}
        visitsFailed={home.visitsFailed}
      />
    </ClockProvider>
  );
}
