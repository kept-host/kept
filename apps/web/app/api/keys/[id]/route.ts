/**
 * `DELETE /api/keys/:id` — revoke one of the signed-in account's API keys.
 * 204; the key fails on its very next use (no cache, `lib/agents/keys.ts`).
 *
 * Another account's key and an id that names nothing are the same 404 — "not
 * yours" is not an existence oracle. Revoking your own revoked key is 204 again.
 * Origin-gated first (E05a): a hosted page must not revoke its visitor's keys.
 */
import { NextResponse } from "next/server";

import { revokeKey } from "../../../../lib/agents/keys";
import { getSession } from "../../../../lib/auth/session";
import { getProfileForSession } from "../../../../lib/db/queries/profile";
import { refuseUntrustedOrigin } from "../../../../lib/publish/origin";
import { ownerResponse, refuse, signedOut } from "../../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Writes a row and depends on the session cookie. Never cacheable. */
export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const foreign = refuseUntrustedOrigin(request);
  if (foreign) return foreign;

  const profile = await getProfileForSession(await getSession());
  if (!profile) return ownerResponse(signedOut());

  const { id } = await params;
  if (!(await revokeKey(profile.id, id))) {
    return ownerResponse(refuse("not_found", "No such key on this account."));
  }
  return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
}
