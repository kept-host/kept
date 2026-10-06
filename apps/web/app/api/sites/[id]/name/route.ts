/**
 * `PATCH /api/sites/:id/name` — an owner moves one of their KEPT pages to a name
 * they chose (PRD §5.4, D3). E06 task 006; replaces E06's first `/slug` route.
 *
 * Body: `{ name }`. Success is `{ site }` — the page as it now is. Every rule
 * (kept-and-`live` only, the name rule, the namespace under a per-name lock, the
 * quota, `RENAMES_PER_DAY`) and the store ordering — `writeManifest(new)` →
 * commit → `removeManifest(old)` — live in `lib/names/rename.ts`; nothing about
 * either belongs here. R2 is untouched: objects are keyed by `siteId`.
 *
 * PATCH: it changes one field of an existing resource, and each call that moves
 * the name issues purges. Renaming a page to the name it already has is a no-op
 * success that writes nothing and purges nothing.
 */
import type { NextResponse } from "next/server";

import { getSession } from "../../../../../lib/auth/session";
import { getProfileForSession } from "../../../../../lib/db/queries/profile";
import {
  readJsonOnlyBody,
  UnreadableBodyError,
} from "../../../../../lib/publish/http";
import { refuseUntrustedOrigin } from "../../../../../lib/publish/origin";
import {
  changeOwnedSiteName,
  ownerResponse,
  refuse,
  signedOut,
} from "../../../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Writes a row, KV and R2's pointer, and depends on the session cookie. */
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // E05a D3 — the session cookie is ambient authority, so a cross-origin caller
  // is refused before the body is read and before anything is written. A hosted
  // page renaming its publisher's other pages is exactly the same-site CSRF
  // `SameSite` cannot block. See `lib/publish/origin.ts`.
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

  const { id } = await params;
  return ownerResponse(await changeOwnedSiteName(id, body, profile.id));
}
