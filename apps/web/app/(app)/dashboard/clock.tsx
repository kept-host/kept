"use client";

/**
 * One clock for the whole dashboard — E06 task 003.
 *
 * ── WHY THIS IS A PROVIDER AND NOT A HOOK EACH CARD CALLS ────────────────────
 * A hook per card is a timer per card. On a wall of twenty pages that is twenty
 * intervals, twenty cleanup paths and twenty independent re-render schedules for
 * a value that changes once a minute, identically, for every one of them. One
 * interval at the screen level, one state update, one render pass — and exactly
 * one `clearInterval` to get right.
 *
 * ── WHY THE FIRST VALUE ARRIVES AS A PROP ────────────────────────────────────
 * `initialNow` comes from the server component that renders this. The first
 * client render therefore produces the same label the server already streamed,
 * so there is no hydration mismatch and — more visibly — no flash of
 * "calculating" on a screen whose entire subject is time. `Date.now()` in
 * `useState`'s initialiser would defeat both.
 *
 * ── WHY THE CLOCK IS NOT GATED ON `prefers-reduced-motion` ───────────────────
 * A countdown that stops updating is not a calmer interface, it is a wrong one.
 * Reduced motion is honoured where motion actually is — the card's hover lift is
 * behind `motion-safe:`, and the live dot's pulse already was — and never by
 * withholding a fact. The tick changes text once a minute; nothing moves.
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import type { SiteStatus } from "@kept/shared";

import { DraftChip, draftCountdown } from "@/components/kept/draft-chip";
import { SiteStatusDot } from "@/components/kept/live-url";
import { effectiveStatus } from "@/lib/sites/display";
import { cn } from "@/lib/utils";

import { useSiteClock } from "./keep-state";

/**
 * Half a minute. The labels have minute granularity, which the PRD accepts, so
 * a full-minute interval would let "1 hour left" sit on screen up to 59 seconds
 * after it stopped being true. Sampling at half the granularity bounds the lie
 * at 30 seconds for one timer on the page, which is the cheap half of the trade.
 */
const TICK_MS = 30_000;

const NowContext = createContext<number | null>(null);

export function ClockProvider({
  initialNow,
  children,
}: {
  /** The server's `Date.now()` at render — see the header. */
  initialNow: number;
  children: ReactNode;
}) {
  const [now, setNow] = useState(initialNow);

  useEffect(() => {
    // Catch up before the first tick. `initialNow` is already seconds old by the
    // time this runs, and a tab woken from bfcache can be hours behind — waiting
    // a full TICK_MS to notice would show a stale countdown on exactly the visit
    // where it matters most.
    setNow(Date.now());

    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return <NowContext.Provider value={now}>{children}</NowContext.Provider>;
}

function useNow(): number {
  const now = useContext(NowContext);
  if (now === null) {
    // Falling back to `Date.now()` here would hydrate to a different value than
    // the server rendered and hide the wiring mistake behind a mismatch warning.
    throw new Error("<SiteState> must be rendered inside <ClockProvider>.");
  }
  return now;
}

/**
 * What a card says about itself right now: its serving state and, for a draft,
 * how long it has.
 *
 * THE PHASE COMES FROM THE CLOCK, NEVER FROM `status`. A draft that crosses
 * `expires_at` while this screen is open flips here, client-side, on the next
 * tick — the *row* does not flip until E07's sweep runs, and a card that read
 * `status` would keep insisting an expired page was live for as long as the
 * sweep was behind.
 *
 * The two facts are rendered together, and the redundant half is dropped: a
 * draft shows its countdown and no serving dot, because the chip already says
 * everything the dot would. That test is against the row's OWN `status`, not
 * against `shown` — an expired draft's `shown` is `expired` and its chip reads
 * "Draft · expired", and rendering both put "Expired · Draft · expired" on the
 * card, which is how it looked the first time this screen was rendered. A draft
 * gets a dot only for a status E07 actually wrote, which the clock cannot say.
 *
 * ── THE CLOCK CAN ALSO MOVE BECAUSE OF A WRITE (E06 task 007) ────────────────
 * A keep or a swap changes `expires_at` while this screen is open, and the whole
 * point of `SwapResult` carrying both halves is that both cards flip from that
 * one response. So the value rendered is `useSiteClock`'s — the server's, until
 * a parsed response has moved it — and `expiresAt` below is the seed, not the
 * authority. Nothing here predicts; the override only ever holds what the
 * database already committed.
 */
export function SiteState({
  siteId,
  status,
  expiresAt,
  className,
}: {
  /** Which row this is, so a write can find its card. */
  siteId: string;
  status: SiteStatus;
  /** The draft clock as the server rendered it. `null` → kept, and no other split. */
  expiresAt: Date | null;
  className?: string;
}) {
  const now = new Date(useNow());
  const clock = useSiteClock(siteId, expiresAt);
  const { phase } = draftCountdown(clock, now);
  const shown = effectiveStatus(status, phase === "expired");
  const isDraft = clock !== null;

  // The card is honest about itself the instant the transaction commits; the
  // *grouping* around it was rendered by the server and cannot move without a
  // refetch the acceptance rule forbids. Saying so is cheaper than a wall that
  // quietly disagrees with its own headings.
  const regrouped = isDraft !== (expiresAt !== null);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {isDraft && status === "live" ? null : <SiteStatusDot status={shown} />}
        {isDraft ? <DraftChip expiresAt={clock} now={now} /> : null}
      </div>

      {regrouped ? (
        <p className="mono-label text-[10px] leading-relaxed text-text-muted">
          {isDraft
            ? "Moves into Drafts next time this screen loads."
            : "Moves into Kept next time this screen loads."}
        </p>
      ) : null}
    </div>
  );
}
