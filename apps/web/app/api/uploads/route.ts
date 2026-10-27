/**
 * `POST /api/uploads` — a signed-in caller asks for a presigned PUT URL for a
 * zip too large for one inline request (E08 D5). `{ size_bytes }` →
 * `200 { upload_id, upload_url, expires_at, max_bytes }`; the browser PUTs the
 * zip straight to R2, then publishes (`POST /api/sites`) or replaces
 * (`POST /api/sites/:id/replace`) with `{ upload_id }`.
 *
 * Session only — anonymous and keyless callers never get a URL (401), and API
 * keys arrive with E09. Cookie-authenticated and mutating (it spends the hour's
 * upload quota and authorises an R2 write), so it is origin-gated like every
 * studio route (E05a D3).
 *
 * THIS FILE IS THE HTTP BOUNDARY AND THE SESSION LOOKUP, AND NOTHING ELSE. The
 * ceiling, the limiter and the signing are `lib/uploads/upload.ts`'s.
 */
import type { NextResponse } from "next/server";

import { getSession } from "../../../lib/auth/session";
import { getProfileForSession } from "../../../lib/db/queries/profile";
import { publishPaused } from "../../../lib/launch";
import { publishPausedResponse, readJsonOnlyBody, UnreadableBodyError } from "../../../lib/publish/http";
import { refuseUntrustedOrigin } from "../../../lib/publish/origin";
import {
  ownerResponse,
  refuse,
  requestOwnedUpload,
  signedOut,
} from "../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** Mints a one-off credential and counts against a limit. Never cacheable. */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  // E09 task 011: the operator's pause comes first — it reads nothing.
  if (publishPaused()) return publishPausedResponse("studio");

  // Then the session cookie is ambient authority, so a script on a hosted
  // page could otherwise spend its visitor's upload quota. See `lib/publish/origin.ts`.
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

  return ownerResponse(await requestOwnedUpload(body, profile.id, profile.plan));
}
