/**
 * `POST /api/admin/moderation/reports` — dismiss reports from the moderation
 * screen (E07 §6.11, AC21). Body `{ reportIds, note }` (`dismissReportsSchema`).
 * Admin session + origin check; anyone else gets 404.
 */
import type { NextResponse } from "next/server";

import { adminSessionFor } from "../../../../../lib/auth/admin";
import { adminNotFound, dismissReportsResponse } from "../../../../../lib/moderation/admin-http";
import { refuseUntrustedOrigin } from "../../../../../lib/publish/origin";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Writes rows and depends on the session cookie. Never cacheable. */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  // E05a D3: a cross-origin caller is refused before anything is read.
  const foreign = refuseUntrustedOrigin(request);
  if (foreign) return foreign;

  const admin = await adminSessionFor(request);
  if (!admin) return adminNotFound();

  return dismissReportsResponse(request, admin.user.id);
}
