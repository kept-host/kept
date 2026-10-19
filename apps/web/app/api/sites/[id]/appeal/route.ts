/**
 * `POST /api/sites/:id/appeal` — the owner asks for a review of a restricted
 * page (E07 §6.10). Body `{ message }`. Every rule is `lib/moderation/appeals.ts`'s
 * and every answer `lib/moderation/appeal-http.ts`'s.
 */
import type { NextResponse } from "next/server";

import { getSession } from "../../../../../lib/auth/session";
import { getProfileForSession } from "../../../../../lib/db/queries/profile";
import { appealOwnedSite, appealRefusal } from "../../../../../lib/moderation/appeal-http";
import { readJsonOnlyBody, UnreadableBodyError } from "../../../../../lib/publish/http";
import { refuseUntrustedOrigin } from "../../../../../lib/publish/origin";
import { ownerResponse, signedOut } from "../../../../../lib/sites/owner-routes";

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

  let body: unknown;
  try {
    body = await readJsonOnlyBody(request);
  } catch (err) {
    if (err instanceof UnreadableBodyError) return appealRefusal("invalid");
    throw err;
  }

  const { id } = await params;
  return appealOwnedSite(id, body, profile.id);
}
