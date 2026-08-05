/**
 * `DELETE /api/sites/:anonToken` — stop serving a page.
 *
 * The token is a path segment for the reason written down in
 * `../replace/route.ts`: it is a bearer capability that has to be pasteable, so
 * it is kept out of query strings and out of every log line.
 *
 * THE HTTP BOUNDARY AND NOTHING ELSE. `deletePage` owns the ordering that makes
 * this safe — `removeManifest` (pointer → KV → purge) before the row is
 * archived, never KV first, and the bytes are archived rather than destroyed.
 */
import { NextResponse } from "next/server";

import { deletePage } from "../../../../lib/publish/anon-manage";
import { errorResponse } from "../../../../lib/publish/http";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** A delete mutates two stores and purges a third. Never cacheable. */
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ anonToken: string }> },
): Promise<NextResponse> {
  const { anonToken } = await params;
  const outcome = await deletePage(anonToken);

  if (!outcome.ok) return errorResponse(outcome.status, outcome.body);

  return NextResponse.json(outcome.body, {
    status: outcome.status,
    headers: { "cache-control": "no-store" },
  });
}
