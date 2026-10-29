/**
 * `PATCH /api/profile` — display name, bio, socials and badge style (E10 D12,
 * PRD §4.6, AC19). Body: any subset of `profileUpdateRequestSchema`. Success is
 * the profile as it now stands (`profileResultSchema`).
 *
 * Validation, the minimal-badge plan gate and the badge re-sync live in
 * `lib/profile/profile.ts`; nothing about them belongs here.
 */
import type { NextResponse } from "next/server";

import { getSession } from "../../../lib/auth/session";
import { getProfileForSession } from "../../../lib/db/queries/profile";
import { readJsonOnlyBody, UnreadableBodyError } from "../../../lib/publish/http";
import { refuseUntrustedOrigin } from "../../../lib/publish/origin";
import { ownerResponse, refuse, signedOut, updateOwnProfile } from "../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Writes rows and depends on the session cookie. */
export const dynamic = "force-dynamic";

export async function PATCH(request: Request): Promise<NextResponse> {
  // E05a D3 — the session cookie is ambient authority: a hosted page must not
  // be able to rewrite its visitor's profile.
  const foreign = refuseUntrustedOrigin(request);
  if (foreign) return foreign;

  const profile = await getProfileForSession(await getSession());
  if (!profile) return ownerResponse(signedOut());

  let body: unknown;
  try {
    body = await readJsonOnlyBody(request);
  } catch (err) {
    if (err instanceof UnreadableBodyError) {
      return ownerResponse(refuse("invalid_request", err.message));
    }
    throw err;
  }

  return ownerResponse(await updateOwnProfile(body, profile));
}
