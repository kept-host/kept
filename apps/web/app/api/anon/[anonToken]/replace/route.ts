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

import { closedModeAccess, keylessPlan } from "../../../../../lib/launch-access";
import { notOpenResponse, publishPaused } from "../../../../../lib/launch";
import { replacePage } from "../../../../../lib/publish/anon-manage";
import { readFileSet } from "../../../../../lib/publish/fileset/read";
import {
  browserChannel,
  errorResponse,
  keptClientFrom,
  publishPausedResponse,
} from "../../../../../lib/publish/http";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** A replace mutates three stores and purges the fourth. Never cacheable. */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ anonToken: string }> },
): Promise<Response> {
  // E09 task 011: the operator's pause, before anything is read or spent.
  if (publishPaused()) return publishPausedResponse();

  // E06a §1: closed, only an access token or an admin session gets past this —
  // checked first, before anything is read or written. RETIRE with
  // `lib/launch-access.ts`.
  const door = await closedModeAccess(request);
  if (!door) return notOpenResponse();

  const { anonToken } = await params;

  // The same inputs as publish, on the same keyless plan (E08 §5.3), read only
  // once the token resolved and the per-page governor admitted the request.
  const outcome = await replacePage(
    anonToken,
    () => readFileSet(request, { plan: keylessPlan(door), uploaderId: null }),
    browserChannel(request),
    keptClientFrom(request),
  );

  if (!outcome.ok) return errorResponse(outcome.status, outcome.body);

  return NextResponse.json(outcome.body, {
    status: outcome.status,
    headers: { "cache-control": "no-store" },
  });
}
