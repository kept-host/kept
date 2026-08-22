/**
 * `(app)/dashboard` — the wall of pages, and the screen the account exists for.
 * E06 task 003, replacing E05's placeholder wholesale.
 *
 * ── ONE READ, TWO GROUPS, ONE PREDICATE ──────────────────────────────────────
 * `getDashboardSites()` is a single round trip that returns the owner's rows
 * already split by `expires_at != null` and a quota counted by the *same*
 * function the cap branch enforces with (`keptQuotaFor`, via `isKeptCondition`).
 * There is no `fetch` to this app's own API, no server action, and no second
 * gate: `(app)/layout.tsx` gates every route in the group, and a page that
 * re-gated itself would be a page that could ship opted out.
 *
 * Note that `kept.length` and `quota.used` may legitimately differ — the wall
 * shows every clockless row the account owns, including an `archived` one, while
 * the quota counts only what the cap counts. Printing `kept.length` in the
 * header would reinstate the second definition of kept-ness that task 002 exists
 * to delete.
 *
 * ── NOTHING IS HIDDEN ────────────────────────────────────────────────────────
 * `quarantined`, `under_review`, `expired` and `archived` pages all appear, all
 * labelled. A page that vanishes from its owner's dashboard the moment it is
 * flagged is indistinguishable from data loss, and the owner's next move is a
 * support email asking where it went.
 *
 * ── NO AGGREGATE NUMBERS ─────────────────────────────────────────────────────
 * The quota is an allowance, not a statistic. Pages served, bytes stored and
 * uptime belong to `/stats` (E09) and must not appear here.
 *
 * DESIGNED FROM TOKENS, NOT IMPORTED. `kept Dashboard.dc.html` was not available
 * to this task; the screen is composed from `globals.css`'s tokens and the
 * existing kept components in the house language — editorial type, hairline
 * rules, mono meta-labels, warm canvas. A later reconciliation pass against the
 * export is a known follow-up.
 */
import Link from "next/link";

import { DRAFT_SECTION_NOTE } from "@/components/kept/draft-chip";
import { KeptQuotaChip } from "@/components/kept/kept-quota";
import { Mascot } from "@/components/kept/mascot";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/auth/session";
import { getDashboardSites, type OwnedSite } from "@/lib/db/queries/dashboard";
import { getProfileForSession } from "@/lib/db/queries/profile";
import { liveUrl } from "@/lib/publish/pipeline";

import { ClockProvider } from "./clock";
import { SiteCard } from "./site-card";

export default async function DashboardPage() {
  // A read, not a gate. The group layout already turned a signed-out visitor
  // away; this resolves *which* account is looking.
  const profile = await getProfileForSession(await getSession());
  if (!profile) {
    // Unreachable past the layout unless the profile bootstrap itself failed —
    // and the failure mode to avoid is rendering the empty state, which would
    // tell somebody with three kept pages that they have none. Throwing lands on
    // `./error.tsx`, which offers a retry.
    throw new Error("Signed in, but no profile resolved for the session.");
  }

  const { kept, drafts, quota } = await getDashboardSites(profile.id);

  // One reading of the clock for the whole screen, taken here so the server's
  // countdown labels and the first client render agree exactly.
  const now = Date.now();
  const nothingYet = kept.length === 0 && drafts.length === 0;

  return (
    <ClockProvider initialNow={now}>
      <main className="mx-auto w-full max-w-[1100px] px-6 pb-28 pt-12 md:px-8 md:pt-16">
        <header className="border-b border-border pb-8">
          <p className="mono-label text-[11px] text-text-muted">Your account</p>
          <h1 className="mt-3 font-display text-[clamp(2.1rem,5.5vw,3.1rem)] font-bold text-text">
            Your pages
          </h1>
          {/* The allowance, from the one function that counts it. `note` adds the
              way out when the account is full — the cap degrades, it never
              errors, so it must never read like a wall. */}
          <KeptQuotaChip quota={quota} note className="mt-6" />
        </header>

        {nothingYet ? (
          <FirstRun />
        ) : (
          <>
            <Section
              title="Kept"
              count={kept.length}
              unit="page"
              empty="Nothing kept yet. Keep a draft and it stays at its link for good."
            >
              {kept}
            </Section>

            <Section
              title="Drafts"
              count={drafts.length}
              unit="draft"
              note={DRAFT_SECTION_NOTE}
              empty="No drafts right now. Every page starts as one."
            >
              {drafts}
            </Section>
          </>
        )}
      </main>
    </ClockProvider>
  );
}

/**
 * A group of pages under its own rule and header.
 *
 * Both sections render even when one is empty: the two groups *are* the product's
 * model of a page, and a dashboard that hid the drafts header until a draft
 * existed would never teach anyone that drafts are a thing.
 */
function Section({
  title,
  count,
  unit,
  note,
  empty,
  children,
}: {
  title: string;
  count: number;
  /** Singularised in the counter — "1 page", "4 pages". */
  unit: string;
  note?: string;
  empty: string;
  children: OwnedSite[];
}) {
  return (
    <section className="mt-14">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-border pb-3">
        <h2 className="font-display text-xl font-semibold text-text">{title}</h2>
        <p className="mono-label text-[11px] text-text-muted">
          {count} {unit}
          {count === 1 ? "" : "s"}
        </p>
      </div>

      {note ? (
        <p className="mt-4 max-w-[62ch] text-sm leading-relaxed text-text-secondary">
          {note}
        </p>
      ) : null}

      {children.length === 0 ? (
        <p className="mt-5 text-sm leading-relaxed text-text-secondary">{empty}</p>
      ) : (
        // `items-start`: without it every card in a row stretches to the tallest
        // one, so a single flagged page's explanation opens a half-card of empty
        // white in each of its neighbours. Each card takes its own height.
        <div className="mt-6 grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {children.map((site) => (
            <SiteCard key={site.id} site={site} liveUrl={liveUrl(site.slug)} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * An account with nothing in it — an invitation, not an empty grid.
 *
 * The mascot is E05b's and is used exactly as `/auth` uses it: the caller owns
 * size and colour, the component owns motion, and E06 changes neither it nor
 * `packages/shared/src/mascot/`.
 *
 * The button points at the landing's drop box because that is where publishing
 * lives today; task 009 puts a real drop zone on this screen and takes this
 * button's place.
 */
function FirstRun() {
  return (
    <section className="mx-auto mt-16 flex max-w-[34rem] flex-col items-center gap-5 rounded-[var(--r-xl)] border border-border bg-surface px-8 py-14 text-center shadow-[var(--shadow-sm)]">
      <Mascot className="block size-24 text-accent" />
      <h2 className="font-display text-2xl font-semibold text-text">
        Nothing kept yet
      </h2>
      <p className="max-w-[44ch] leading-relaxed text-text-secondary">
        Drop an HTML file and it is live at its own link straight away — no
        account needed to publish, no build step, no waiting.
      </p>
      <p className="max-w-[44ch] text-sm leading-relaxed text-text-muted">
        {DRAFT_SECTION_NOTE}
      </p>
      <Button asChild className="mt-1">
        <Link href="/">Publish your first page</Link>
      </Button>
    </section>
  );
}
