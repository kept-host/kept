import KeptLanding from "@/components/kept/KeptLanding";

/**
 * kept landing — Claude Design v2 ("drop-box choreography").
 *
 * A single client component owns the whole page: the fixed traveling tile that
 * docks into every section as the user scrolls the self-scrolling `#kept-root`
 * container, procedural canvas thumbnails, the pinned How/Agents sections, the
 * gauge dot grid, and the drop/mint/live flow. The engine (KeptEngine) runs a
 * rAF loop entirely on the client; no publish/auth/live-data wiring yet.
 */
export default function MarketingHome() {
  return <KeptLanding />;
}
