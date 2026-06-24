"use client";

import * as React from "react";
import dynamic from "next/dynamic";

import { VesselStill } from "@/components/kept/VesselStill";

/**
 * VesselMount — the integration seam for the live Vessel (frontend-specs §7).
 *
 * Decides, on the client, whether to mount the real R3F scene or the static
 * still. The still is rendered when WebGL is unavailable OR the user prefers
 * reduced motion (both are first-class fallbacks, not a blank). Otherwise the
 * R3F `Vessel` is dynamically imported with `ssr:false` behind a still-shaped
 * loading placeholder, so it never causes layout shift and only ships R3F to
 * routes that actually show the Vessel.
 *
 * Reduced-motion users who *do* have WebGL still get the R3F scene, but it
 * renders a single settled frame (frameloop="demand") instead of a static DOM
 * still — a richer, still-motionless fallback.
 */
const Vessel = dynamic(() => import("./Vessel"), {
  ssr: false,
  loading: () => <VesselStill />,
});

/** True when the browser can create a WebGL context. */
function detectWebGL(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      window.WebGLRenderingContext &&
        (canvas.getContext("webgl") || canvas.getContext("experimental-webgl")),
    );
  } catch {
    return false;
  }
}

export function VesselMount() {
  // Render the still on the server and until we've probed the client. This keeps
  // SSR/first-paint markup stable (no hydration mismatch) and is the graceful
  // fallback when WebGL is missing.
  const [mode, setMode] = React.useState<"still" | "canvas">("still");
  const [reducedMotion, setReducedMotion] = React.useState(false);

  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const hasWebGL = detectWebGL();

    const apply = () => {
      const reduce = mq.matches;
      setReducedMotion(reduce);
      // No WebGL → DOM still. WebGL present → canvas (it self-stills on reduce).
      setMode(hasWebGL ? "canvas" : "still");
    };

    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  return (
    <div className="relative z-[1]" data-vessel="mount">
      {mode === "canvas" ? <Vessel reducedMotion={reducedMotion} /> : <VesselStill />}
    </div>
  );
}
