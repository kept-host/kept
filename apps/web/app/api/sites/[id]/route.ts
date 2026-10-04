/**
 * The page itself — E06 tasks 006, 008 and 012.
 *
 *   · `PATCH /api/sites/:id` — its Details: `{ title?, listedPublic? }` (task
 *     012, PRD §5.2). Rules in `lib/sites/details.ts`.
 *   · `DELETE /api/sites/:id` — an owner takes one page off the internet (D14).
 *
 * A ROUTE FILE AT A SEGMENT THAT ALREADY HAS CHILDREN (`keep`, `demote`,
 * `name`, `replace`, `download`). That is legal in the App Router and is the
 * honest place for both verbs: the resource being changed or deleted is the
 * page itself, not a sub-resource of it. No `GET` is added — the studio reads
 * Postgres directly from server components (the locked rule), so a JSON read of
 * a site would be a second, unused way to ask the same question, gated
 * differently.
 *
 * ⚠️ THIS ARCHIVES; IT DOES NOT DESTROY. `status → 'archived'` with
 * `purge_after = now + DRAFT_GRACE_DAYS`, a chosen name held; the row, the R2
 * object and the versions stay for the owner's download window, and the kept
 * slot frees because `isKeptCondition` excludes `archived`. Owners reach
 * `archived`; `removed` is E07's.
 *
 * The edge-first ordering (`removeManifest` → archive) lives in
 * `lib/sites/manage.ts`; nothing about it belongs here.
 */
import type { NextResponse } from "next/server";

import { getSession } from "../../../../lib/auth/session";
import { getProfileForSession } from "../../../../lib/db/queries/profile";
import { readJsonOnlyBody, UnreadableBodyError } from "../../../../lib/publish/http";
import { refuseUntrustedOrigin } from "../../../../lib/publish/origin";
import {
  deleteOwnedSite,
  ownerResponse,
  refuse,
  signedOut,
  updateOwnedSite,
} from "../../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** Writes a row, or deletes a pointer and a KV key and purges. Never cacheable. */
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // E05a D3 — the session cookie is ambient authority, so a cross-origin caller
  // (a hosted page retitling its publisher's other pages) is refused before the
  // body is read and before anything is written.
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
  return ownerResponse(await updateOwnedSite(id, body, profile.id));
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // The gate binds to cookie use, not to method: this spends the session
  // cookie, so a foreign origin is refused before the session is even resolved.
  const foreign = refuseUntrustedOrigin(request);
  if (foreign) return foreign;

  const profile = await getProfileForSession(await getSession());
  if (!profile) return ownerResponse(signedOut());

  // No body is read. A delete carries its whole meaning in the path, and
  // accepting one would invite a second way to name the page being deleted.
  const { id } = await params;
  return ownerResponse(await deleteOwnedSite(id, profile.id));
}
