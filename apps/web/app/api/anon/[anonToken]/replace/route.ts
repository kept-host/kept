/**
 * `POST /api/anon/:anonToken/replace` — new bytes, same URL.
 *
 * THE TOKEN IS A PATH SEGMENT, NOT A QUERY STRING, and that is the security
 * decision this file exists to record. It is a bearer capability: whoever holds
 * it can replace or delete the page, with no other authentication. A query
 * string lands in access logs, proxy logs, analytics and `Referer` headers by
 * default; a path segment lands in fewer of them. It is the least-bad option
 * rather than a good one, and it is forced — the token has to be pasteable into
 * a browser address bar for `/p/[anonToken]` to work at all, which rules out an
 * `Authorization` header.
 *
 * THE HTTP BOUNDARY AND NOTHING ELSE. The token lookup, the validation, the
 * store ordering and the unwind are in `lib/publish/anon-manage.ts`.
 */
import { NextResponse } from "next/server";

import { replacePage } from "../../../../../lib/publish/anon-manage";
import {
  errorResponse,
  readPageBody,
  UnreadableBodyError,
} from "../../../../../lib/publish/http";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** A replace mutates three stores and purges the fourth. Never cacheable. */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ anonToken: string }> },
): Promise<NextResponse> {
  const { anonToken } = await params;

  let body: unknown;
  try {
    body = await readPageBody(request);
  } catch (err) {
    if (err instanceof UnreadableBodyError) {
      return errorResponse(400, { error: "invalid_request", message: err.message });
    }
    throw err;
  }

  const outcome = await replacePage(anonToken, body);

  if (!outcome.ok) return errorResponse(outcome.status, outcome.body);

  return NextResponse.json(outcome.body, {
    status: outcome.status,
    headers: { "cache-control": "no-store" },
  });
}
