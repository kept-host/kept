/**
 * `POST /api/anon/:anonToken/appeal` — the token holder asks for a review of a
 * restricted page (E07 §6.10). Body `{ message }`.
 *
 * A BEARER ROUTE: the token in the path is the authority, so there is no origin
 * check (E05a — `lib/publish/origin.ts`). The token is a path segment for the
 * reason written down in `../replace/route.ts`, and is never logged.
 */
import { closedModeAccess } from "../../../../../lib/launch-access";
import { notOpenResponse } from "../../../../../lib/launch";
import { appealAnonSite, appealRefusal } from "../../../../../lib/moderation/appeal-http";
import { readJsonOnlyBody, UnreadableBodyError } from "../../../../../lib/publish/http";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Writes a row. Never cacheable. */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ anonToken: string }> },
): Promise<Response> {
  // E06a §1: closed, only an access token or an admin session gets past this —
  // checked first, before anything is read or written. RETIRE with
  // `lib/launch-access.ts`.
  if (!(await closedModeAccess(request))) return notOpenResponse();

  const { anonToken } = await params;

  let body: unknown;
  try {
    body = await readJsonOnlyBody(request);
  } catch (err) {
    if (err instanceof UnreadableBodyError) return appealRefusal("invalid");
    throw err;
  }

  return appealAnonSite(anonToken, body);
}
