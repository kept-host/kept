/**
 * `POST /api/sites/swap` — demote one kept page and keep another, atomically.
 *
 * Body: `{ demote: siteId, keep: siteId }`. Both must be owned by the caller
 * and they must differ; `demote === keep` is the one 400 this family emits,
 * because swapping a page with itself would demote the page it is meant to
 * keep. Everything else a caller can get wrong — a page that is not theirs, an
 * id that does not exist — is the same 404 as everywhere else in `/api/sites/`.
 *
 * ⚠️ `swap` IS A STATIC SEGMENT SITTING BESIDE `[id]`. Next resolves static
 * segments before dynamic ones, so `/api/sites/swap` reaches this handler and
 * is never captured as an id by `[id]/keep` or `[id]/demote`. That is asserted
 * over the wire in `e2e/owner-sites-api.spec.ts` rather than assumed — it is
 * the sort of routing property that is free to check and expensive to discover.
 *
 * The atomicity is the feature: one transaction, so the account can never be
 * observed a slot short or a page over `KEPT_PAGE_LIMIT`. No store call here
 * either — a swap is two Postgres writes and nothing else.
 */
import type { NextResponse } from "next/server";

import { getSession } from "../../../../lib/auth/session";
import { getProfileForSession } from "../../../../lib/db/queries/profile";
import {
  errorResponse,
  readJsonOnlyBody,
  UnreadableBodyError,
} from "../../../../lib/publish/http";
import { ownerResponse, signedOut, swapOwnedSites } from "../../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Writes two rows and depends on the session cookie. Never cacheable. */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const profile = await getProfileForSession(await getSession());
  if (!profile) return ownerResponse(signedOut());

  let body: unknown;
  try {
    body = await readJsonOnlyBody(request);
  } catch (err) {
    if (err instanceof UnreadableBodyError) {
      return errorResponse(400, { error: "invalid_request", message: err.message });
    }
    throw err;
  }

  return ownerResponse(await swapOwnedSites(body, profile.id));
}
