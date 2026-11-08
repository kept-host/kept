/**
 * `PUT /api/profile/handle` — set or change the account's handle (E10 D9, D10,
 * PRD §5.5). Body: `{ handle }`. Success is `{ handle, nextChangeOn }`.
 *
 * The lock order, the 30-day limit, the permanent hold, the redirect
 * manifests and the badge re-sync live in `lib/handles/handle.ts`; nothing
 * about them belongs here. Saving the handle the account already has is a
 * no-op success.
 */
import type { NextResponse } from "next/server";

import { getSession } from "../../../../lib/auth/session";
import { getProfileForSession } from "../../../../lib/db/queries/profile";
import { readJsonOnlyBody, UnreadableBodyError } from "../../../../lib/publish/http";
import { refuseUntrustedOrigin } from "../../../../lib/publish/origin";
import { changeOwnHandle, ownerResponse, refuse, signedOut } from "../../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Writes a row, KV and R2's pointer, and depends on the session cookie. */
export const dynamic = "force-dynamic";

export async function PUT(request: Request): Promise<NextResponse> {
  // E05a D3 — the session cookie is ambient authority: a hosted page must not
  // be able to change its visitor's handle (and so where their old one points).
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

  return ownerResponse(await changeOwnHandle(body, profile.id));
}
