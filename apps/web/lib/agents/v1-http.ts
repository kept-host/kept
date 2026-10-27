/**
 * The HTTP boundary every `/api/v1/*` route shares (E09 D8): who is calling,
 * and how an outcome leaves.
 *
 * BEARER KEY ONLY. No origin check and no cookie: a request carrying only the
 * session cookie is `401 unauthorized` (AC7) — a hosted page's script rides
 * its visitor's cookie, never a key it does not have.
 */
import { closedModeAccess } from "../launch-access";
import { notOpenResponse } from "../launch";
import { keyedErrorResponse } from "../publish/http";

import { keyCallerFrom, type KeyCaller } from "./keys";
import type { KeyedOutcome } from "./pages";

/**
 * The key's caller, or the response that ends the request. Closed, only an
 * admin's key passes (`closedModeAccess`'s `key` door) — everyone else gets the
 * middleware's `not_open`, having read nothing.
 */
export async function v1Caller(request: Request): Promise<KeyCaller | Response> {
  if ((await closedModeAccess(request)) === null) return notOpenResponse();
  const caller = await keyCallerFrom(request);
  return (
    caller ??
    keyedErrorResponse(401, {
      error: "unauthorized",
      message: "Send `Authorization: Bearer kpt_live_…` with a live API key. Create one in Settings → Agents and API keys.",
    })
  );
}

/** One outcome → response mapping for every `/api/v1/*` route. Never cacheable. */
export function v1Response<T>(outcome: KeyedOutcome<T>): Response {
  if (!outcome.ok) return keyedErrorResponse(outcome.status, outcome.body);
  return Response.json(outcome.body, { status: outcome.status, headers: { "cache-control": "no-store" } });
}
