/**
 * `POST /api/publish` — the endpoint the whole epic exists for.
 *
 * THE API IS THE PRODUCT. The landing hero is one client of this route and
 * E09's MCP tools will be a second, wrapping the same contract without
 * modifying it. Nothing in the request or the response assumes a browser: a
 * bare `curl -X POST` with an HTML body — or a folder's files, or a zip (E08
 * D3) — gets the full seven-field contract back, with no Turnstile, no cookie
 * and no auth.
 *
 * THIS FILE IS THE HTTP BOUNDARY AND NOTHING ELSE — content types in, status
 * codes out. Reading the file set is `readFileSet`'s; validation, dedup,
 * minting, the four-store write and the unwind all live in
 * `lib/publish/pipeline.ts`, which is callable with no server running. No zod
 * parsing here, no SQL, no store client.
 */
import { NextResponse } from "next/server";

import { closedModeAccess, keylessPlan } from "../../../lib/launch-access";
import { notOpenResponse } from "../../../lib/launch";
import { readFileSet } from "../../../lib/publish/fileset/read";
import { errorResponse, publisherFrom } from "../../../lib/publish/http";
import { publishPage } from "../../../lib/publish/pipeline";

/**
 * Node, not edge: `postgres-js` needs TCP sockets and `aws4fetch` signs with
 * Node's crypto. The SERVING path is 100% Cloudflare and untouched by this —
 * the control plane running on Railway is the whole point of the split.
 */
export const runtime = "nodejs";

/** Every publish mutates four stores; nothing about it is cacheable. */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // E06a §1: closed, only an access token or an admin session gets past this —
  // checked first, before anything is read or written. RETIRE with
  // `lib/launch-access.ts`.
  const door = await closedModeAccess(request);
  if (!door) return notOpenResponse();

  // Keyless callers publish on `free` caps; the closed deploy's token and admin
  // doors on `premium` (E08 §5.3). No uploads: there is no account to own one.
  // The pipeline reads the body only after its request ceiling admits it.
  const outcome = await publishPage(
    () => readFileSet(request, { plan: keylessPlan(door), uploaderId: null }),
    publisherFrom(request),
  );

  if (!outcome.ok) return errorResponse(outcome.status, outcome.body);

  return NextResponse.json(outcome.body, {
    status: outcome.status,
    // The response carries the raw anon token exactly once. It must not be
    // cached by anything between here and the caller.
    headers: { "cache-control": "no-store" },
  });
}
