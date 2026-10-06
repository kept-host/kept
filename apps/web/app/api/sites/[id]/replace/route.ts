/**
 * `POST /api/sites/:id/replace` — an owner drops a new file on a page they
 * already have. E06 task 006.
 *
 * Body: the same three content types as `POST /api/publish` (`application/json`
 * with `{ html }`, `multipart/form-data` with an `html` part, or a raw
 * `text/html` document), read through the one shared extractor so a dropped
 * `.html` file and a pasted document arrive here identically.
 *
 * THE BEARER TWIN IS `POST /api/anon/:token/replace`, AND IT STAYS SEPARATE.
 * Its store ordering is reused verbatim through `lib/publish/pipeline.ts`; what
 * is not reused is the authority — a token in the path versus a site id plus a
 * session cookie. One handler accepting both credentials is how one eventually
 * accepts the other (E05 D3).
 *
 * ⚠️ THE SLUG DOES NOT MOVE AND THE CLOCK DOES NOT RESET. `lib/sites/manage.ts`
 * owns both rules and the R2 → pointer → KV → purge ordering; nothing about
 * them belongs here.
 */
import type { NextResponse } from "next/server";

import { getSession } from "../../../../../lib/auth/session";
import { getProfileForSession } from "../../../../../lib/db/queries/profile";
import {
  readPageBody,
  UnreadableBodyError,
} from "../../../../../lib/publish/http";
import { refuseUntrustedOrigin } from "../../../../../lib/publish/origin";
import {
  ownerResponse,
  refuse,
  replaceOwnedSite,
  signedOut,
} from "../../../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** Writes a row, an R2 object and KV, then purges. Never cacheable. */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // E05a D3 — the session cookie is ambient authority, so a cross-origin caller
  // is refused before the body is read and before anything is written. A hosted
  // page rewriting its publisher's other pages is exactly the same-site CSRF
  // `SameSite` cannot block. See `lib/publish/origin.ts`.
  const foreign = refuseUntrustedOrigin(request);
  if (foreign) return foreign;

  const profile = await getProfileForSession(await getSession());
  if (!profile) return ownerResponse(signedOut());

  let body: unknown;
  try {
    body = await readPageBody(request);
  } catch (err) {
    if (err instanceof UnreadableBodyError) {
      return ownerResponse(refuse("invalid_request", err.message));
    }
    throw err;
  }

  const { id } = await params;
  return ownerResponse(await replaceOwnedSite(id, body, profile.id));
}
