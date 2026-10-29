/**
 * `(app)/referrals` — E10 D11, PRD §5.6, AC18, from `kept Settings
 * Screen.dc.html`'s Referrals section.
 *
 * The link (`{landing}/?ref={handle ?? code}`, from configuration, never the
 * request) and the code, each with Copy; the verified sign-up count; the
 * list — a date and a display name, never an email; "Earnings start when Pro
 * billing launches" (D-22: no rewards before billing); and the large-creator
 * line, which points at the founding application (the one creator channel
 * that exists).
 *
 * States: populated · empty (no verified sign-ups yet) · loading
 * (`./loading.tsx`) · error (`./error.tsx`). The `(app)` layout gates it.
 */
import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/session";
import { getProfileForSession } from "@/lib/db/queries/profile";
import { referralStatsFor } from "@/lib/referrals/stats";
import { landingHref, referralHref } from "@/lib/routing/host-split";

import { Wordmark } from "../wordmark";
import { CopyField } from "./copy-field";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Referrals · kept",
};

const DATE = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const EARNINGS_LINE = "Earnings start when Pro billing launches.";

export default async function ReferralsPage() {
  const profile = await getProfileForSession(await getSession());
  if (!profile) redirect("/auth?next=%2Freferrals");

  const stats = await referralStatsFor(profile);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const link = referralHref(appUrl, stats.refCode);

  return (
    <>
      <header className="flex h-16 items-center border-b border-border px-4 md:hidden">
        <Wordmark className="text-[22px]" />
      </header>

      <main className="flex max-w-[760px] flex-col gap-6 px-4 pb-24 pt-8 md:px-10">
        <h1 className="font-display text-[clamp(32px,6cqw,40px)] font-bold leading-[1.1] tracking-[-0.03em] text-text">
          Referrals
        </h1>

        <section className="flex flex-col gap-3.5 rounded-[var(--r-lg)] border border-border bg-surface p-5">
          <p className="text-[15px] text-pretty text-text-secondary">
            The kept mark on your pages carries your code. So does this link.
          </p>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-2">
            <CopyField label="CODE" value={stats.refCode} testId="referral-code" />
            <CopyField value={link} testId="referral-link" />
          </div>

          <div className="flex items-baseline gap-2.5 pt-1.5">
            <span
              data-testid="referral-count"
              className="font-display text-[32px] font-bold leading-none tracking-[-0.03em] text-text"
            >
              {stats.verifiedCount}
            </span>
            <span className="text-[15px] text-text-secondary">
              verified sign-up{stats.verifiedCount === 1 ? "" : "s"}
            </span>
          </div>

          {stats.referrals.length === 0 ? (
            <p data-testid="referrals-empty" className="border-t border-border pt-3 text-[15px] text-text-secondary">
              No sign-ups yet. When someone joins through your link and verifies their email, they show up here.
            </p>
          ) : (
            <ul data-testid="referrals-list" className="flex flex-col">
              {stats.referrals.map((referral, index) => (
                <li key={`${referral.createdAt}-${index}`} className="flex items-center gap-3 border-t border-border py-2.5">
                  <span
                    aria-hidden="true"
                    className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sunken font-display text-xs font-bold uppercase text-text"
                  >
                    {(referral.displayName ?? "?")[0]}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-text">
                    {referral.displayName ?? "Someone"}
                  </span>
                  <time dateTime={referral.createdAt} className="font-mono text-xs text-text-secondary">
                    {DATE.format(new Date(referral.createdAt))}
                  </time>
                </li>
              ))}
            </ul>
          )}

          <p data-testid="referrals-earnings" className="rounded-[var(--r-md)] bg-accent-soft px-3.5 py-3 text-sm text-text">
            {EARNINGS_LINE}
          </p>
          <p className="text-sm text-text-secondary">
            Bringing a large audience?{" "}
            <a href={landingHref(appUrl, "/founding")} className="font-medium text-accent underline-offset-4 hover:underline">
              Apply as a founding creator
            </a>{" "}
            and we&apos;ll talk.
          </p>
        </section>
      </main>
    </>
  );
}
