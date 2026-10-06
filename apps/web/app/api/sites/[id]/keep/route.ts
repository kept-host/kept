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
 * ⚠️ AT THE CAP THIS IS `409 at_kept_limit` (E06 task 004, PRD §10.2). The page
 * is already an owned draft, so — unlike the anonymous door, which still lands
 * `owned_draft` — there is nothing to attach and nothing is written. The limit
 * is the account's plan's (`limitsFor(plan).keptPages`).
 *
 * Archived, removed and past-grace pages are the same 404 as a page that never
 * existed; `under_review` / `quarantined` are `409 not_allowed_in_status`.
 *
 * One store call, on one branch: the LATE KEEP of an `expired` page inside its
 * grace window writes its manifest again after the Postgres commit, through
 * `lib/sites/keep.ts`. Keeping a `live` page is a Postgres write only.
 */
import type { NextResponse } from "next/server";

import { getSession } from "../../../../../lib/auth/session";
import { getProfileForSession } from "../../../../../lib/db/queries/profile";
import { refuseUntrustedOrigin } from "../../../../../lib/publish/origin";
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
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // E05a D3 — the session cookie is ambient authority, so a cross-origin caller
  // is refused before anything is read. See `lib/publish/origin.ts`.
  const foreign = refuseUntrustedOrigin(request);
  if (foreign) return foreign;

  const profile = await getProfileForSession(await getSession());
  if (!profile) return ownerResponse(signedOut());

  const { id } = await params;
  return ownerResponse(await keepOwnedSite(id, profile.id));
}
