/**
 * `POST /api/sites/bulk` — keep or delete many of the owner's pages at once
 * (the drafts tab's multi-select).
 *
 * Body: `{ action: "keep" | "delete", ids: string[] }`, at most
 * `BULK_MAX_PAGES` ids. 200 `{ results }`, one per distinct id; the one
 * whole-request refusal is a keep past the owner's free kept slots,
 * `409 at_kept_limit`, with nothing kept. Every rule is the single-page verb's,
 * mapped in `lib/sites/owner-routes.ts` — nothing about keeping or deleting
 * belongs here.
 *
 * ⚠️ `bulk` IS A STATIC SEGMENT SITTING BESIDE `[id]`, like `swap`: Next
 * resolves static segments first, so `/api/sites/bulk` reaches this handler
 * and is never captured as an id by `[id]/route.ts`.
 */
import type { NextResponse } from "next/server";

import { getSession } from "../../../../lib/auth/session";
import { getProfileForSession } from "../../../../lib/db/queries/profile";
import { readJsonOnlyBody, UnreadableBodyError } from "../../../../lib/publish/http";
import { refuseUntrustedOrigin } from "../../../../lib/publish/origin";
import {
  bulkOwnedSites,
  ownerResponse,
  refuse,
  signedOut,
} from "../../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** Writes rows, deletes pointers and KV keys, purges. Never cacheable. */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  // E05a D3 — the session cookie is ambient authority: ungated, a script on a
  // hosted page could take every one of its visitor's drafts offline in one
  // request. Refused before the session lookup and before the body is read.
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

  return ownerResponse(await bulkOwnedSites(body, profile.id));
}
