/**
 * `POST /api/sites/:id/versions/:versionId/restore` — an owner serves an older
 * version of their page again, or presses Undo after a replace (D7, AC25).
 * E06 task 007. No body.
 *
 * ⚠️ NO PAGE BYTES ARE WRITTEN. The version's object is already in R2; the
 * restore moves `current_version_id` and the manifest (`lib/sites/restore.ts`
 * owns that ordering and its unwind). Owner only, `live` only, and the version
 * must be this page's — another page's version is `404 version_not_found`.
 */
import type { NextResponse } from "next/server";

import { getSession } from "../../../../../../../lib/auth/session";
import { getProfileForSession } from "../../../../../../../lib/db/queries/profile";
import { refuseUntrustedOrigin } from "../../../../../../../lib/publish/origin";
import {
  ownerResponse,
  restoreOwnedVersion,
  signedOut,
} from "../../../../../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** Moves a row and KV, then purges. Never cacheable. */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> },
): Promise<NextResponse> {
  // E05a D3 — the session cookie is ambient authority, so a cross-origin caller
  // is refused before anything is read. See `lib/publish/origin.ts`.
  const foreign = refuseUntrustedOrigin(request);
  if (foreign) return foreign;

  const profile = await getProfileForSession(await getSession());
  if (!profile) return ownerResponse(signedOut());

  const { id, versionId } = await params;
  return ownerResponse(await restoreOwnedVersion(id, versionId, profile.id));
}
