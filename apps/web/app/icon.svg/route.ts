import { brandMascotSvg, brandTokens } from "@/lib/og/brand";

/** The SVG favicon (E06a §8): the frozen mascot in the accent, rendered once at build. */
export const dynamic = "force-static";

export function GET() {
  const { accent, bg } = brandTokens();
  return new Response(brandMascotSvg(accent, bg), {
    headers: { "content-type": "image/svg+xml" },
  });
}
