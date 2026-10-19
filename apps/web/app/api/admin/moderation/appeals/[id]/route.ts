/**
 * `POST /api/admin/moderation/appeals/:id` — grant or reject an appeal from the
 * moderation screen (E07 §6.10, §6.11). Body `{ decision, note }`
 * (`appealDecisionSchema`). Admin session + origin check; anyone else gets 404.
 */
import type { NextResponse } from "next/server";

import { adminSessionFor } from "../../../../../../lib/auth/admin";
import { adminNotFound, appealDecisionResponse } from "../../../../../../lib/moderation/admin-http";
import { refuseUntrustedOrigin } from "../../../../../../lib/publish/origin";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Writes rows and depends on the session cookie. Never cacheable. */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // E05a D3: a cross-origin caller is refused before anything is read.
  const foreign = refuseUntrustedOrigin(request);
  if (foreign) return foreign;

  const admin = await adminSessionFor(request);
  if (!admin) return adminNotFound();

  const { id } = await params;
  return appealDecisionResponse(id, request, admin.user.id);
}
