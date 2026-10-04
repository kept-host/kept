/**
 * `GET /api/names/check?name=&siteId=` — the name field's live answer (PRD
 * §5.4). E06 task 006.
 *
 * `{ status }` plus the numbers its sentence interpolates, never the sentence:
 * the words are `lib/names/messages.ts`'s. `siteId` must be the caller's page
 * (404 otherwise, the same body as a page that does not exist). Limited per
 * account per minute in process — see `allowNameCheck` for why that is enough.
 *
 * A session-authenticated READ, so no origin gate: it changes nothing, and the
 * same-site page that could send it cannot read the answer (no CORS grant).
 */
import type { NextResponse } from "next/server";

import { getSession } from "../../../../lib/auth/session";
import { getProfileForSession } from "../../../../lib/db/queries/profile";
import {
  checkOwnedName,
  ownerResponse,
  signedOut,
} from "../../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Reads the session cookie and live rows; never cacheable. */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const profile = await getProfileForSession(await getSession());
  if (!profile) return ownerResponse(signedOut());

  const params = new URL(request.url).searchParams;
  return ownerResponse(
    await checkOwnedName(params.get("siteId"), params.get("name"), profile.id),
  );
}
