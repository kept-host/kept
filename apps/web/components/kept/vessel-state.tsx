"use client";

import * as React from "react";

/**
 * VesselState — the interaction bus the Vessel subscribes to (frontend-specs §7).
 *
 * One lightweight context exposes the Vessel's phase plus a few continuous
 * inputs. Phase 1 wires `idle` + pointer parallax (the Vessel reads pointer
 * directly via R3F, not through here) and consumes `scrollProgress` so Phase 2
 * scroll choreography can drive rotation by simply calling `setScrollProgress`.
 * `dragover` / `minting` + `progress` are the E1 publish-flow seams; `health`
 * (0..1) is the E4 funding signal that modulates orb brightness.
 *
 * Kept deliberately tiny: a single reducer-free context with a setter hook so
 * the producers (publish flow, scroll listener, gauge) and the one consumer
 * (the R3F scene) never re-render each other unnecessarily.
 */

export type VesselPhase = "idle" | "dragover" | "minting" | "scrolling";

export type VesselState = {
  /** Coarse interaction state. Drives inhale / rise / rim-pulse behaviour. */
  phase: VesselPhase;
  /** Publish progress 0..1 (E1). Reserved; `minting` reads this in a later epic. */
  progress: number;
  /** Funding health 0..1 (E4). Modulates orb brightness — brighter = comfier runway. */
  health: number;
  /** Hero scroll progress 0..1 (Phase 2). Scrubs vessel rotation/tilt. */
  scrollProgress: number;
};

type VesselStateContext = VesselState & {
  setPhase: (phase: VesselPhase) => void;
  setProgress: (progress: number) => void;
  setHealth: (health: number) => void;
  setScrollProgress: (scrollProgress: number) => void;
};

const DEFAULT_STATE: VesselState = {
  phase: "idle",
  progress: 0,
  health: 0.82,
  scrollProgress: 0,
};

const Context = React.createContext<VesselStateContext | null>(null);

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export function VesselStateProvider({
  children,
  initialHealth = DEFAULT_STATE.health,
}: {
  children: React.ReactNode;
  initialHealth?: number;
}) {
  const [state, setState] = React.useState<VesselState>({
    ...DEFAULT_STATE,
    health: clamp01(initialHealth),
  });

  const value = React.useMemo<VesselStateContext>(
    () => ({
      ...state,
      setPhase: (phase) => setState((s) => (s.phase === phase ? s : { ...s, phase })),
      setProgress: (progress) =>
        setState((s) => ({ ...s, progress: clamp01(progress) })),
      setHealth: (health) => setState((s) => ({ ...s, health: clamp01(health) })),
      setScrollProgress: (scrollProgress) =>
        setState((s) => ({ ...s, scrollProgress: clamp01(scrollProgress) })),
    }),
    [state],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/**
 * Read + set Vessel state. Returns the default (idle) snapshot when used outside
 * a provider so the Vessel can render standalone in isolation/tests.
 */
export function useVesselState(): VesselStateContext {
  const ctx = React.useContext(Context);
  if (ctx) return ctx;
  return {
    ...DEFAULT_STATE,
    setPhase: () => {},
    setProgress: () => {},
    setHealth: () => {},
    setScrollProgress: () => {},
  };
}
