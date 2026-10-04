/**
 * `POST /api/sites` — a signed-in user publishes a page they own from its first
 * byte. Decision **D9**: `201 { site }` for a new page (kept, or an owned draft
 * at the plan's limit — never an error), `200 { site, duplicate: true }` when
 * the account already has these exact bytes live. Refusals answer the studio
 * envelope `{ error: { code, message } }`.
 *
 * THE COLLECTION ROUTE, and a static sibling of `[id]` — Next resolves the two
 * without ambiguity, and `[id]/keep`, `[id]/demote`, `[id]/replace`, `[id]/slug`
 * and `swap` are all untouched by it.
 *
 * ⚠️ IT IS NOT `POST /api/publish` WITH A COOKIE, AND THE TWO MUST NOT MERGE.
 * That route is keyless by design — it mints an anonymous bearer token, leaves
 * `owner_id` null and starts a 7-day clock — and it is the path E08's agents
 * take, so it stays callable from anywhere with no origin check. This one spends
 * the `__Host-` session cookie, so it is origin-gated like every other
 * cookie-authenticated mutation (E05a D3). Same product verb, two authority
 * models, two doors.
 *
 * Body: the same three content types as `POST /api/publish` (`application/json`
 * with `{ html }`, `multipart/form-data` with an `html` part, or a raw
 * `text/html` document), through the one shared extractor — so the dashboard's
 * drop-zone and a `curl` from a signed-in terminal arrive here identically.
 *
 * THIS FILE IS THE HTTP BOUNDARY AND THE SESSION LOOKUP, AND NOTHING ELSE. The
 * cap branch, the transaction, the row and the R2 → pointer → KV → purge
 * ordering are all below `lib/sites/owner-routes.ts`, exactly as they are for
 * the other five owner verbs.
 */
import type { NextResponse } from "next/server";

import { getSession } from "../../../lib/auth/session";
import { getProfileForSession } from "../../../lib/db/queries/profile";
import {
  publisherFrom,
  readPageBody,
  UnreadableBodyError,
} from "../../../lib/publish/http";
import { refuseUntrustedOrigin } from "../../../lib/publish/origin";
import {
  ownerResponse,
  publishOwnedSite,
  refuse,
  signedOut,
} from "../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** Writes a row, an R2 object and KV, then purges. Never cacheable. */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  // FIRST, before the body is read and before the session is resolved. The
  // session cookie is ambient authority, so a script on a hosted page could
  // otherwise publish pages into its visitor's account — same-site CSRF, which
  // `SameSite` does not block. See `lib/publish/origin.ts`.
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

  return ownerResponse(await publishOwnedSite(body, profile.id, publisherFrom(request)));
}
