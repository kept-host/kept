/**
 * `GET /api/sites/:id/download` — an owner saves one page's current HTML
 * (D13, §5.7). E06 task 008.
 *
 * THE HTTP BOUNDARY AND THE SESSION LOOKUP, AND NOTHING ELSE. Who may download
 * what, and the streamed read from R2, live in `lib/sites/export.ts`; the
 * response headers in `lib/sites/owner-routes.ts`. A GET that changes nothing,
 * so there is no origin check: another origin cannot read the response.
 */
import { getSession } from "../../../../../lib/auth/session";
import { getProfileForSession } from "../../../../../lib/db/queries/profile";
import {
  downloadOwnedSite,
  ownerResponse,
  signedOut,
} from "../../../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** One owner's bytes, read per request. Never cacheable. */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const profile = await getProfileForSession(await getSession());
  if (!profile) return ownerResponse(signedOut());

  const { id } = await params;
  return downloadOwnedSite(id, profile.id);
}
