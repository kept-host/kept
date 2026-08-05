/**
 * `POST /api/publish` — the endpoint the whole epic exists for.
 *
 * THE API IS THE PRODUCT. The landing hero is one client of this route and
 * E08's MCP tools will be a second, wrapping the same contract without
 * modifying it. Nothing in the request or the response assumes a browser: a
 * bare `curl -X POST` with an HTML body gets the full seven-field contract
 * back, with no Turnstile, no cookie and no auth.
 *
 * THIS FILE IS THE HTTP BOUNDARY AND NOTHING ELSE — content types in, status
 * codes out. Validation, dedup, minting, the four-store write and the unwind
 * all live in `lib/publish/pipeline.ts`, which is callable with no server
 * running. No zod parsing here, no SQL, no store client.
 */
import { NextResponse } from "next/server";

import {
  errorResponse,
  readPageBody,
  UnreadableBodyError,
} from "../../../lib/publish/http";
import { publishPage, type PublisherContext } from "../../../lib/publish/pipeline";

/**
 * Node, not edge: `postgres-js` needs TCP sockets and `aws4fetch` signs with
 * Node's crypto. The SERVING path is 100% Cloudflare and untouched by this —
 * the control plane running on Railway is the whole point of the split.
 */
export const runtime = "nodejs";

/** Every publish mutates four stores; nothing about it is cacheable. */
export const dynamic = "force-dynamic";

/**
 * The publisher's identity for dedup and E07's rate limiter.
 *
 * The raw address is read here, handed to the salted hash, and then dropped: it
 * is never stored, never logged, and never returned. Railway (and any proxy in
 * front of it) sets `x-forwarded-for`; the first entry is the client.
 */
function publisherFrom(request: Request): PublisherContext {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real = request.headers.get("x-real-ip")?.trim();
  return {
    ip: forwarded || real || "unknown",
    userAgent: request.headers.get("user-agent") ?? "",
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readPageBody(request);
  } catch (err) {
    if (err instanceof UnreadableBodyError) {
      return errorResponse(400, { error: "invalid_request", message: err.message });
    }
    throw err;
  }

  const outcome = await publishPage(body, publisherFrom(request));

  if (!outcome.ok) return errorResponse(outcome.status, outcome.body);

  return NextResponse.json(outcome.body, {
    status: outcome.status,
    // The response carries the raw anon token exactly once. It must not be
    // cached by anything between here and the caller.
    headers: { "cache-control": "no-store" },
  });
}
