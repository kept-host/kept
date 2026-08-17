/**
 * `GET /auth/callback` — where a keep survives the sign-in round trip. Task 009.
 *
 * A visitor pressed "Keep it forever" on `/keep/[anonToken]`, was handed to
 * GitHub, Google or their inbox, and has just come back. Everything they were
 * carrying is in one httpOnly cookie: the bearer token that names the page.
 * This is the ONLY place that cookie is read, and it is read exactly once.
 *
 * ── WHY A ROUTE HANDLER AND NOT A PAGE ─────────────────────────────────────
 * The task sketched `app/auth/callback/page.tsx`. It cannot be one, for two
 * reasons that were both observed rather than assumed:
 *
 *   1. **A page render must be free of side effects, and this is nothing but a
 *      side effect.** Next's client router renders a page component more than
 *      once per navigation — a prefetch and the navigation itself, an eager
 *      render inside a server action's redirect response — and each extra render
 *      would be another keep attempt. Route handlers are never prefetched and
 *      never rendered speculatively: one request, one execution.
 *   2. **Only a Route Handler (or a Server Action) may delete a cookie.** Next
 *      throws on a cookie mutation during a Server Component render, so a page
 *      would have to farm the delete out to middleware — which cannot be atomic
 *      with the render and, in practice, leaves the cookie alive across exactly
 *      the duplicate renders in (1).
 *
 * The screen the visitor actually sees is `./done/page.tsx`, reached by the
 * redirect below with the outcome in the address bar. That is also better UX
 * than rendering here: the confirmation survives a refresh and the back button,
 * which a cookie-derived screen never could.
 *
 * ── READ ONCE ──────────────────────────────────────────────────────────────
 * The cookie is deleted on the response before the keep is attempted, so a
 * replay of this URL — a refresh, the back button, a link preloader — carries
 * nothing and falls into the "no intent" branch. The delete is on the same
 * response as every exit, including the failure ones: a spent intent stays
 * spent, and the visitor's own keep link is the retry.
 *
 * ── THE TOKEN GOES NO FURTHER THAN THIS FUNCTION ───────────────────────────
 * Not rendered, not logged, not put in a redirect target. What travels to
 * `./done` is the slug (which is the page's public hostname), one outcome word,
 * and — at the cap — the draft deadline.
 *
 * ── WHY IT CALLS THE LIBRARY, NOT `POST /api/anon/:anonToken/keep` ─────────
 * That route is thirteen lines: session → profile → `keepAnonymousPage`. Calling
 * it over HTTP from here would mean rebuilding an absolute URL, forwarding the
 * session cookie by hand, and putting the bearer token in an outbound request
 * line — to reach identical code. Task 008 split the HTTP boundary from the
 * logic precisely so both doors could share the logic; this is the second door.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  expiredPendingKeepCookie,
  PENDING_KEEP_COOKIE,
} from "../../../lib/auth/pending-keep";
import { RETURN_PARAM, safeReturnPath } from "../../../lib/auth/return-path";
import { getSession } from "../../../lib/auth/session";
import { getProfileForSession } from "../../../lib/db/queries/profile";
import { keepAnonymousPage } from "../../../lib/sites/anon-keep";
import { doneHref, doneHrefForKeep } from "./done/outcomes";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** Reads a cookie and writes a row. Never cacheable, never prerendered. */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);

  /**
   * Every exit goes through here, so the cookie cannot survive any of them.
   * `303` because the visitor arrived by navigation and must land on a GET they
   * can safely reload.
   */
  const leave = (path: string): NextResponse => {
    const response = NextResponse.redirect(new URL(path, url), 303);
    response.cookies.set(expiredPendingKeepCookie());
    return response;
  };

  const token = (await cookies()).get(PENDING_KEEP_COOKIE)?.value;

  if (!token) {
    // No intent pending: an ordinary post-sign-in landing, or a replay of a
    // callback that already ran. `?next=` goes through the same validator every
    // other return path uses — it arrives from the address bar, and validating
    // it only on the write side is not validating it at all.
    return leave(safeReturnPath(url.searchParams.get(RETURN_PARAM)));
  }

  const profile = await getProfileForSession(await getSession());
  // Reachable only if the sign-in did not complete — a declined consent that
  // still redirected, or a session that expired between the two requests.
  if (!profile) return leave(doneHref({ outcome: "signed-out" }));

  return leave(doneHrefForKeep(await keepAnonymousPage(token, profile.id)));
}
