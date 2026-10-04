"use client";

/**
 * One clock for the whole studio screen — E06 task 003; task 011 keeps it as
 * the Pages home's ticker (`components/kept/site-card.tsx` reads `useNow`) and
 * task 012's page detail mounts it for its status chip and Keep action.
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

/**
 * The screen's one "now", in epoch ms. Exported for `components/kept/site-card.tsx`
 * (E06 task 010), whose draft countdown reads this ticker rather than starting
 * a second one.
 */
export function useNow(): number {
  const now = useContext(NowContext);
  if (now === null) {
    // Falling back to `Date.now()` here would hydrate to a different value than
    // the server rendered and hide the wiring mistake behind a mismatch warning.
    throw new Error("This component must be rendered inside <ClockProvider>.");
  }
  return now;
}
