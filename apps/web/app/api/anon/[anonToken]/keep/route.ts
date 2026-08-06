/**
 * `POST /api/anon/:anonToken/keep` — the anonymous→owned door.
 *
 * TWO CREDENTIALS, BOTH REQUIRED, NEITHER SUFFICIENT. The bearer token in the
 * path says *which page*; the session cookie says *whose account*. This is the
 * only route in the product where they meet, and it is why `/api/anon/` and
 * `/api/sites/` are separate prefixes (epic decision D3): one authority model
 * per prefix, so a bearer token can never reach an owner-scoped handler and a
 * session can never walk through the anonymous door on somebody else's draft.
 * The owner-scoped keep is `POST /api/sites/:id/keep` and it leaves
 * `expectAnonymous` at `false`.
 *
 * THE TOKEN IS A PATH SEGMENT for the reason written down in `../replace/route.ts`:
 * it has to be pasteable into a browser, which rules out a header, and a path
 * segment lands in fewer logs than a query string. **Signed out is a 401 and
 * never a redirect** — a `Location` carrying the token would leak it through
 * `Referer` to wherever it lands. Task 009's screen turns this 401 into a
 * sign-in link and resumes the keep from an httpOnly cookie afterwards.
 *
 * THE HTTP BOUNDARY AND NOTHING ELSE: the resolve, the status allowlist, the
 * cap branch and the one manifest write are all in `lib/sites/anon-keep.ts`.
 */
import { NextResponse } from "next/server";

import { getSession } from "../../../../../lib/auth/session";
import { getProfileForSession } from "../../../../../lib/db/queries/profile";
import { errorResponse } from "../../../../../lib/publish/http";
import { keepAnonymousPage } from "../../../../../lib/sites/anon-keep";
// The one signed-out body in the epic, shared with the owner routes so a client
// sees the same 401 whichever keep it called.
import { signedOut } from "../../../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** Writes a row, may write KV, and depends on the session cookie. Never cacheable. */
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ anonToken: string }> },
): Promise<NextResponse> {
  // The session gate runs BEFORE the token is even read: a signed-out request
  // must not cause a lookup, and therefore cannot be timed into an existence
  // probe.
  const profile = await getProfileForSession(await getSession());

  let outcome;
  if (!profile) {
    outcome = signedOut();
  } else {
    const { anonToken } = await params;
    outcome = await keepAnonymousPage(anonToken, profile.id);
  }

  if (!outcome.ok) return errorResponse(outcome.status, outcome.body);

  return NextResponse.json(outcome.body, {
    status: outcome.status,
    headers: { "cache-control": "no-store" },
  });
}
