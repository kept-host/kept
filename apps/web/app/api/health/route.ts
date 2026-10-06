import { NextResponse } from "next/server";

import { SHARED_PACKAGE } from "@kept/shared";

import { keptOpen } from "@/lib/launch";

/**
 * api segment placeholder — proves the route-handler wiring and that the app
 * can import from packages/shared. Real handlers (publish, og, oc-sync,
 * report…) land per-epic from E1 on.
 *
 * `open` is this build's launch gate (`lib/launch.ts`). The release smoke reads
 * it to know which publish check applies: publish → serve → delete on an open
 * deploy, and "the gate holds" on a closed one.
 */
export function GET() {
  return NextResponse.json({ status: "ok", shared: SHARED_PACKAGE, open: keptOpen() });
}
