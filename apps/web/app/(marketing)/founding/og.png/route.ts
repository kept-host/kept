import { brandCardResponse } from "@/lib/og/brand";
import { FOUNDING_CARD } from "@/lib/og/preview";

/** `/founding`'s link-preview card (E06a §8), rendered once at build. */
export const dynamic = "force-static";

export function GET() {
  return brandCardResponse(FOUNDING_CARD);
}
