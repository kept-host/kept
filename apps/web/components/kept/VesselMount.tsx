"use client";

import dynamic from "next/dynamic";

/**
 * VesselMount — the integration seam for the live Vessel (frontend-specs §7).
 *
 * Dynamically imports the (currently static) Vessel with `ssr: false` behind a
 * <Suspense>-style `loading` fallback, so a later epic can swap the body of
 * `Vessel.tsx` for the real R3F scene without touching the landing page. The
 * fallback mirrors the placeholder footprint to avoid layout shift.
 */
const Vessel = dynamic(() => import("./Vessel"), {
  ssr: false,
  loading: () => (
    <div
      className="h-[560px] w-full"
      aria-hidden
      data-vessel="loading"
    />
  ),
});

export function VesselMount() {
  return (
    <div className="relative z-[1]" data-vessel="mount">
      <Vessel />
    </div>
  );
}
