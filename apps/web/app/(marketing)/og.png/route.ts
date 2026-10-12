import { brandCardResponse } from "@/lib/og/brand";
import { LANDING_CARD } from "@/lib/og/preview";

/** The apex's link-preview card (E06a §8), rendered once at build. */
export const dynamic = "force-static";

export function GET() {
  return brandCardResponse(LANDING_CARD);
}
