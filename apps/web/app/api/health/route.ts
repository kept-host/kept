import { NextResponse } from "next/server";

import { SHARED_PACKAGE } from "@kept/shared";

/**
 * api segment placeholder — proves the route-handler wiring and that the app
 * can import from packages/shared. Real handlers (publish, og, oc-sync,
 * report…) land per-epic from E1 on.
 */
export function GET() {
  return NextResponse.json({ status: "ok", shared: SHARED_PACKAGE });
}
