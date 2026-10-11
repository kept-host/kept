import type { Metadata } from "next";

import KeptLanding from "@/components/kept/KeptLanding";
import { landingMetadata } from "@/lib/og/preview";

/**
 * kept landing — Claude Design v2 ("drop-box choreography").
 *
 * A single client component owns the whole page: the fixed traveling tile that
 * docks into every section as the user scrolls the self-scrolling `#kept-root`
 * container, procedural canvas thumbnails, the pinned How/Agents sections, the
 * gauge dot grid, and the drop/mint/live flow. The engine (KeptEngine) runs a
 * rAF loop entirely on the client; no publish/auth/live-data wiring yet.
 */
/**
 * Resolved per request: the preview's absolute image URL comes from
 * `NEXT_PUBLIC_APP_URL`, which a build without app env (CI) does not have — a
 * module-scope `metadata` const would read it at build time and fail it.
 */
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return landingMetadata();
}

export default function MarketingHome() {
  return <KeptLanding />;
}
