/**
 * `POST /api/sites/:id/keep` — an owner keeps one of their own pages forever.
 *
 * ⚠️ NOT THE ANONYMOUS DOOR. The anonymous→owned keep is
 * `POST /api/anon/:anonToken/keep`: bearer-token authority, a different prefix,
 * a different handler. This one is session authority over a row that ALREADY
 * belongs to the caller, which is why `keepOwnedSite` leaves `keepSite`'s
 * `expectAnonymous` at `false`. `/api/sites/` is owner-scoped and
 * session-authenticated end to end (epic decision D3); a bearer token gets
 * nothing here.
 *
 * ⚠️ AT THE CAP THIS IS STILL A 200. The page becomes an *owned draft* with its
 * countdown intact and `outcome: "owned_draft"` in the body. There is no 4xx
 * for being at `KEPT_PAGE_LIMIT`.
 *
 * No store call on this path: keeping is a Postgres write, the page is already
 * `live` and already serving, and nothing in the Worker reads `owner_id`.
 */
import type { NextResponse } from "next/server";

import { getSession } from "../../../../../lib/auth/session";
import { getProfileForSession } from "../../../../../lib/db/queries/profile";
import {
  keepOwnedSite,
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
  return ownerResponse(await keepOwnedSite(id, profile.id));
}
