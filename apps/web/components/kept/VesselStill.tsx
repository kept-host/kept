/**
 * VesselStill — the static rendered still of the Vessel (frontend-specs §7).
 *
 * This is the no-WebGL / reduced-motion fallback AND the loading placeholder.
 * A frosted glass capsule holding one glowing violet orb, with a warm contact
 * shadow — the same silhouette the R3F scene draws, so swapping between them
 * causes no layout shift. Token-driven; theme-aware via CSS vars. The float bob
 * is `motion-safe:` only, so reduced-motion users get a truly static image.
 *
 * It occupies the exact 560px footprint of the live canvas.
 */
export function VesselStill() {
  return (
    <div className="relative flex h-[560px] w-full items-center justify-center">
      {/* contact shadow */}
      <div
        aria-hidden
        className="absolute bottom-16 left-1/2 h-[60px] w-[320px] -translate-x-1/2 rounded-[50%] blur-[8px]"
        style={{
          background:
            "radial-gradient(ellipse at center, color-mix(in srgb, var(--text) 18%, transparent), transparent 70%)",
        }}
      />
      {/* the vessel — a glassy urn with a glowing accent orb */}
      <div
        aria-hidden
        className="motion-safe:animate-[keptFloat_7s_ease-in-out_infinite] relative h-[280px] w-[240px] border border-[color-mix(in_srgb,var(--surface)_50%,transparent)]"
        style={{
          borderRadius: "42% 42% 46% 46% / 46% 46% 50% 50%",
          background:
            "radial-gradient(58% 52% at 50% 60%, color-mix(in srgb, var(--accent) 55%, transparent), transparent 62%), linear-gradient(160deg, color-mix(in srgb, var(--surface) 92%, #fff), color-mix(in srgb, var(--bg) 60%, var(--accent-soft)))",
          boxShadow:
            "var(--shadow-lg), inset 0 2px 14px color-mix(in srgb, var(--surface) 70%, transparent)",
        }}
      >
        <div
          className="absolute left-1/2 top-[56%] h-16 w-16 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            background:
              "radial-gradient(circle, var(--accent-hover), var(--accent) 60%)",
            boxShadow:
              "0 0 50px 14px color-mix(in srgb, var(--accent) 55%, transparent)",
          }}
        />
      </div>
    </div>
  );
}

export default VesselStill;
