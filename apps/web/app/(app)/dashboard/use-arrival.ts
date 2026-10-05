"use client";

/**
 * Which card is arriving on the Pages home, and the keep moment — E06 task 015
 * (`kept Studio Screen.dc.html`, `publish()` and `keep()`).
 *
 * A card arrives through ONE transition that marks it and refreshes the screen,
 * so the refreshed card mounts already marked; the card then times its own ring
 * from that mount (`home-card.tsx`), never from when the response came back.
 *
 * The keep moment: the draft fades where it stands ("Kept"), and
 * `KEEP_MOVE_MS` later the page arrives on the wall. Under reduced motion it
 * moves at once — nothing is animating, so there is nothing to wait for.
 */
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { CardArrival } from "@/components/kept/site-card";
import { prefersReducedMotion } from "@/lib/motion";

/** The design's pause between "Kept" and the page appearing on the wall. */
const KEEP_MOVE_MS = 700;

export interface Arrival {
  id: string;
  kind: CardArrival;
}

export interface Arrivals {
  /** The card arriving now, until it calls `settle`. */
  current: Arrival | null;
  /** The draft fading out after a keep. */
  leavingId: string | null;
  /** Refresh with `next` arriving; `before` lands in the same commit (the mint card leaving). */
  arrive: (next: Arrival, before?: () => void) => void;
  /** That card's arrival is over. */
  settle: (id: string) => void;
  /** A draft was kept (or swapped in): fade it, then bring it in on the wall. */
  keep: (id: string) => void;
}

export function useArrival(): Arrivals {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [current, setCurrent] = useState<Arrival | null>(null);
  const [leavingId, setLeavingId] = useState<string | null>(null);
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (moveTimer.current) clearTimeout(moveTimer.current);
    };
  }, []);

  const arrive = useCallback(
    (next: Arrival, before?: () => void) => {
      startTransition(() => {
        before?.();
        setCurrent(next);
        router.refresh();
      });
    },
    [router],
  );

  const settle = useCallback((id: string) => {
    setCurrent((now) => (now?.id === id ? null : now));
  }, []);

  const keep = useCallback(
    (id: string) => {
      setLeavingId(id);
      if (moveTimer.current) clearTimeout(moveTimer.current);
      moveTimer.current = setTimeout(
        () => arrive({ id, kind: "kept" }, () => setLeavingId(null)),
        prefersReducedMotion() ? 0 : KEEP_MOVE_MS,
      );
    },
    [arrive],
  );

  return { current, leavingId, arrive, settle, keep };
}
