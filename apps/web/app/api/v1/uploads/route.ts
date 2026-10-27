/**
 * `POST /api/v1/uploads` — a presigned PUT for a zip too large for one inline
 * request, for an API key (E08 D5, E09 Q5). `{ size_bytes }` → `{ upload_id,
 * upload_url, expires_at, max_bytes }`; the zip is then published or replaced
 * through `/api/v1/pages` with `{ upload_id }`. The same `createUpload` and the
 * same per-profile hourly bucket as the studio's `/api/uploads`, which is
 * unchanged.
 *
 * Bearer key only. Never log the body — `upload_url` is a bearer credential
 * until it expires.
 */
import { keyedUpload } from "../../../../lib/agents/pages";
import { v1Caller, v1Response } from "../../../../lib/agents/v1-http";
import { publishPaused } from "../../../../lib/launch";
import { keyedErrorResponse, publishPausedResponse, readJsonOnlyBody, UnreadableBodyError } from "../../../../lib/publish/http";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** Mints a one-off credential and counts against a limit. Never cacheable. */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // E09 task 011: the operator's pause comes first — it reads nothing.
  if (publishPaused()) return publishPausedResponse();

  const caller = await v1Caller(request);
  if (caller instanceof Response) return caller;

  let body: unknown;
  try {
    body = await readJsonOnlyBody(request);
  } catch (err) {
    if (err instanceof UnreadableBodyError) {
      return keyedErrorResponse(400, { error: "invalid_request", message: err.message });
    }
    throw err;
  }

  return v1Response(await keyedUpload(caller, body));
}
