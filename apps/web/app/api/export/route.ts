/**
 * `GET /api/export` — an owner saves every page they have as one streamed zip
 * (D13, §5.7). E06 task 008.
 *
 * THE HTTP BOUNDARY AND THE SESSION LOOKUP, AND NOTHING ELSE. The page set and
 * the zip stream live in `lib/sites/export.ts`; the response headers in
 * `lib/sites/owner-routes.ts`. A plain GET with `Content-Disposition:
 * attachment`, so the browser downloads it natively from a link — no
 * fetch-to-blob, nothing held in the tab. No origin check: it changes nothing,
 * and another origin cannot read the response.
 *
 * `?ready=<token>` (task 013) is the settings button's start signal: the
 * response carries a cookie naming that token and whether the zip started, and
 * it arrives exactly when the download begins — see `lib/sites/export-ready.ts`.
 */
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";

import { getSession } from "../../../lib/auth/session";
import { getProfileForSession } from "../../../lib/db/queries/profile";
import {
  EXPORT_READY_COOKIE,
  EXPORT_READY_MAX_AGE_SECONDS,
  EXPORT_READY_PARAM,
  EXPORT_READY_PATH,
  exportReadyToken,
  exportReadyValue,
} from "../../../lib/sites/export-ready";
import { exportOwnPages, ownerResponse, signedOut } from "../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** One owner's pages, streamed per request. Never cacheable. */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const profile = await getProfileForSession(await getSession());
  const response = profile ? await exportOwnPages(profile.id) : ownerResponse(signedOut());

  const token = exportReadyToken(request.nextUrl.searchParams.get(EXPORT_READY_PARAM));
  if (token) {
    (await cookies()).set(EXPORT_READY_COOKIE, exportReadyValue(token, response.ok ? "started" : "failed"), {
      path: EXPORT_READY_PATH,
      maxAge: EXPORT_READY_MAX_AGE_SECONDS,
      sameSite: "strict",
      secure: true,
    });
  }
  return response;
}
