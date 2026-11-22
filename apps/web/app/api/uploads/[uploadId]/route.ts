/**
 * `PUT /api/uploads/{uploadId}?t=<token>` — the zip behind an MCP
 * `create_upload`'s `upload_url`. Any plain `curl -T site.zip '<upload_url>'`:
 * `200 { upload_id, bytes }`, then `publish_page` / `replace_page` with
 * `{ upload_id }`.
 *
 * The token is the whole credential: no cookie, no key, so no origin check
 * (nothing ambient to ride on) and served while closed — it is only minted for
 * a caller that already passed `/mcp`'s closed-mode doors.
 *
 * THIS FILE IS THE HTTP BOUNDARY AND NOTHING ELSE. The token, the ceiling and
 * the store are `lib/uploads/upload.ts`'s. Never log the URL: the token is a
 * bearer credential until it expires.
 */
import { NextResponse } from "next/server";

import { publishPaused } from "../../../../lib/launch";
import { errorResponse, publishPausedResponse } from "../../../../lib/publish/http";
import { receiveUpload } from "../../../../lib/uploads/upload";

/** `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** Writes an object. Never cacheable. */
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ uploadId: string }> };

export async function PUT(request: Request, { params }: Context): Promise<NextResponse> {
  // E09 task 011: the operator's pause comes first — it reads nothing.
  if (publishPaused()) return publishPausedResponse();

  const { uploadId } = await params;
  const outcome = await receiveUpload(uploadId, new URL(request.url).searchParams.get("t"), request);
  return outcome.ok
    ? NextResponse.json(outcome.body, { headers: { "cache-control": "no-store" } })
    : errorResponse(outcome.status, outcome.body);
}
