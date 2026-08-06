/**
 * `POST /api/sites/:id/demote` — an owner puts a kept page back on a clock.
 *
 * ⚠️ DESTRUCTIVE-ISH, AND THE CONFIRMATION IS THE CALLER'S. Nothing is removed:
 * `status` stays `live`, the slug stays, the manifest stays, R2 stays, and the
 * page keeps serving at the same URL. But it acquires a fresh `DRAFT_TTL_DAYS`
 * deadline and will expire unless it is kept again, so a client must confirm
 * ("this page becomes a draft and expires in DRAFT_TTL_DAYS days") *before*
 * calling. E06's dashboard renders that; this endpoint does not, and never
 * calls itself on a page load.
 *
 * The response carries the updated quota so the caller can show "2 of 3 kept"
 * without a second request.
 *
 * No store call on this path either — demote is a Postgres write. The manifest
 * is not rewritten and the cache is not purged, because nothing the Worker
 * reads has changed.
 */
import type { NextResponse } from "next/server";

import { getSession } from "../../../../../lib/auth/session";
import { getProfileForSession } from "../../../../../lib/db/queries/profile";
import {
  demoteOwnedSite,
  ownerResponse,
  signedOut,
} from "../../../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Writes a row and depends on the session cookie. Never cacheable. */
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const profile = await getProfileForSession(await getSession());
  if (!profile) return ownerResponse(signedOut());

  const { id } = await params;
  return ownerResponse(await demoteOwnedSite(id, profile.id));
}
