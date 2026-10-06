/**
 * `DELETE /api/account` — a signed-in user deletes their own account (D16).
 * E06 task 008.
 *
 * ⚠️ THE COLLECTION IS THE CALLER'S OWN ACCOUNT, SO THERE IS NO `[id]` SEGMENT
 * AND NEVER WILL BE. The profile and the email the body must match are resolved
 * from the session below and handed down; nothing a caller can put in a path, a
 * query or a body names whose account is deleted.
 *
 * Only `DELETE` is exported. The counts the confirmation dialog states are a
 * server-component read (`getAccountDeletionSummary`, the locked rule), not a
 * `GET` here.
 *
 * THIS FILE IS THE HTTP BOUNDARY, THE ORIGIN GATE, THE SESSION LOOKUP AND THE
 * COOKIE, AND NOTHING ELSE. The typed-email check, the store unwind, the
 * transaction and the end state all live below `lib/sites/owner-routes.ts`.
 */
import type { NextResponse } from "next/server";

import { auth } from "../../../lib/auth";
import { getSession } from "../../../lib/auth/session";
import { getProfileForSession } from "../../../lib/db/queries/profile";
import {
  readJsonOnlyBody,
  UnreadableBodyError,
} from "../../../lib/publish/http";
import { refuseUntrustedOrigin } from "../../../lib/publish/origin";
import {
  deleteOwnAccount,
  ownerResponse,
  refuse,
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

  const session = await getSession();
  const profile = await getProfileForSession(session);
  if (!session || !profile) return ownerResponse(signedOut());

  let body: unknown;
  try {
    // JSON only. There is no file to accept and no multipart shape to support,
    // and the typed email is one short field — `readJsonOnlyBody` is the same
    // reader the reminder endpoint uses for the same reason.
    body = await readJsonOnlyBody(request);
  } catch (err) {
    if (err instanceof UnreadableBodyError) {
      return ownerResponse(refuse("invalid_request", err.message));
    }
    throw err;
  }

  // The profile id and the email to match come from the session and from
  // nowhere else.
  const outcome = await deleteOwnAccount(body, profile.id, session.user.email);
  const response = ownerResponse(outcome);
  if (outcome.ok) {
    // The session rows went with the user, so every other device is signed out
    // on its next request; this tells THIS browser now, so it lands on the apex
    // signed out with nothing to clear.
    const { authCookies } = await auth.$context;
    for (const { name } of Object.values(authCookies)) {
      response.cookies.set({
        name,
        value: "",
        maxAge: 0,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
      });
    }
  }
  return response;
}
