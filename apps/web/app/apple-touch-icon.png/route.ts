import { brandIconResponse } from "@/lib/og/brand";

/** The home-screen icon (E06a §8): the mascot on `--bg`, 180 px, rendered once at build. */
export const dynamic = "force-static";

export function GET() {
  return brandIconResponse(180, { background: true });
}
