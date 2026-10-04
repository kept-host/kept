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
 */
import { getSession } from "../../../lib/auth/session";
import { getProfileForSession } from "../../../lib/db/queries/profile";
import { exportOwnPages, ownerResponse, signedOut } from "../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** One owner's pages, streamed per request. Never cacheable. */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const profile = await getProfileForSession(await getSession());
  if (!profile) return ownerResponse(signedOut());

  return exportOwnPages(profile.id);
}
