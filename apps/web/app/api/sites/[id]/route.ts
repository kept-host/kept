/**
 * `DELETE /api/sites/:id` — an owner takes one page off the internet.
 * E06 task 006.
 *
 * A ROUTE FILE AT A SEGMENT THAT ALREADY HAS CHILDREN (`keep`, `demote`,
 * `slug`, `replace`). That is legal in the App Router and is the honest place
 * for the verb: the resource being deleted is the page itself, not a
 * sub-resource of it. **Only `DELETE` is exported.** No `GET` is added — the
 * dashboard and the detail screen read Postgres directly from server components
 * (the locked rule), so a JSON read of a site would be a second, unused way to
 * ask the same question, gated differently.
 *
 * ⚠️ THIS ARCHIVES; IT DOES NOT DESTROY. `status → 'archived'`, the row stays,
 * the R2 object stays, the version history stays, and the kept slot frees
 * because `isKeptCondition` excludes `archived`. The account-deletion path
 * (task 011) is the one that ends in `removed` with a `purge_after` — the two
 * terminal states are different on purpose and must not be harmonised.
 *
 * The edge-first ordering (`removeManifest` → `archiveSite`) lives in
 * `lib/sites/manage.ts`; nothing about it belongs here.
 */
import type { NextResponse } from "next/server";

import { getSession } from "../../../../lib/auth/session";
import { getProfileForSession } from "../../../../lib/db/queries/profile";
import { refuseUntrustedOrigin } from "../../../../lib/publish/origin";
import {
  deleteOwnedSite,
  ownerResponse,
  signedOut,
} from "../../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** Deletes a pointer and a KV key, then purges and writes a row. Never cacheable. */
export const dynamic = "force-dynamic";

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
