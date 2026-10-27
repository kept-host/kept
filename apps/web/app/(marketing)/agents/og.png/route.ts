import { brandCardResponse } from "@/lib/og/brand";
import { AGENTS_CARD } from "@/lib/og/preview";

/** `/agents`' link-preview card (E09 task 004), rendered once at build. */
export const dynamic = "force-static";

export function GET() {
  return brandCardResponse(AGENTS_CARD);
}
