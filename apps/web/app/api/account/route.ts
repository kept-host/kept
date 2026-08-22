/**
 * `DELETE /api/account` — a signed-in user destroys their own account.
 * E06 task 011, epic decision **D3**.
 *
 * ⚠️ THE COLLECTION IS THE CALLER'S OWN ACCOUNT, SO THERE IS NO `[id]` SEGMENT
 * AND NEVER WILL BE. The profile is resolved from the session below and handed
 * down; nothing a caller can put in a path, a query or a body names whose
 * account is deleted. That is the difference between "delete my account" and a
 * deletion endpoint that takes a victim.
 *
 * Only `DELETE` is exported. The counts the confirmation dialog states are a
 * server-component read (`getAccountDeletionSummary`, the locked rule), not a
 * `GET` here — a JSON read of an account would be a second way to ask the same
 * question, gated differently.
 *
 * THIS FILE IS THE HTTP BOUNDARY, THE ORIGIN GATE AND THE SESSION LOOKUP, AND
 * NOTHING ELSE. The double gate's second half, the store unwind, the transaction
 * and the terminal row state all live below `lib/sites/owner-routes.ts`.
 */
import type { NextResponse } from "next/server";

import { getSession } from "../../../lib/auth/session";
import { getProfileForSession } from "../../../lib/db/queries/profile";
import {
  errorResponse,
  readJsonOnlyBody,
  UnreadableBodyError,
} from "../../../lib/publish/http";
import { refuseUntrustedOrigin } from "../../../lib/publish/origin";
import {
  deleteOwnAccount,
  ownerResponse,
  signedOut,
} from "../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** Deletes pointers and KV keys, then purges and writes rows. Never cacheable. */
export const dynamic = "force-dynamic";

export async function DELETE(request: Request): Promise<NextResponse> {
  // FIRST, before the body is read and before the session is resolved. The
  // session cookie is ambient authority, so without this a script on a hosted
  // page could delete its visitor's whole kept account — same-site CSRF, which
  // `SameSite` does not block. On the one irreversible verb in the product this
  // is not defence in depth; it is the defence.
  const foreign = refuseUntrustedOrigin(request);
  if (foreign) return foreign;

  const profile = await getProfileForSession(await getSession());
  if (!profile) return ownerResponse(signedOut());

  let body: unknown;
  try {
    // JSON only. There is no file to accept and no multipart shape to support,
    // and the confirmation phrase is one short field — `readJsonOnlyBody` is the
    // same reader the reminder endpoint uses for the same reason.
    body = await readJsonOnlyBody(request);
  } catch (err) {
    if (err instanceof UnreadableBodyError) {
      return errorResponse(400, { error: "invalid_request", message: err.message });
    }
    throw err;
  }

  // The profile id comes from the session and from nowhere else.
  return ownerResponse(await deleteOwnAccount(body, profile.id));
}
