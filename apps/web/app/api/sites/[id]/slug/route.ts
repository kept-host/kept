/**
 * `PATCH /api/sites/:id/slug` — an owner moves one of their pages to a name
 * they chose. E06 task 005.
 *
 * Body: `{ slug }`. The first user-chosen slug in the product's history: every
 * other slug came out of `mintSlugCandidate`, and both of the lists that guard
 * it (`RESERVED_SLUGS`, `PROFANITY_SUBSTRINGS`) were written for eight random
 * characters rather than for a person picking a name. What that does and does
 * NOT cover is written down beside the rule, in `lib/publish/slug.ts`'s
 * `checkChosenSlug` — impersonation and typosquatting are E07's.
 *
 * PATCH, not POST or PUT: this modifies one field of an existing resource and
 * is not idempotent in the store sense (each call issues purges), so PATCH is
 * the honest method. Renaming a page to the name it already has is a no-op
 * success that writes nothing and purges nothing.
 *
 * ⚠️ THE ONLY OWNER ROUTE THAT TOUCHES THE EDGE. `lib/sites/rename.ts` owns the
 * `writeManifest(new) → commit → removeManifest(old)` ordering (epic decision
 * D2) and the reasons it is that way round; nothing about it belongs here.
 * R2 is untouched — objects are keyed by `siteId`, not by slug.
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
  ownerResponse,
  refuse,
  renameOwnedSite,
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
  return ownerResponse(await renameOwnedSite(id, body, profile.id));
}
