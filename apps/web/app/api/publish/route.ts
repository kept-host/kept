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
import { publishErrorSchema, type PublishError } from "@kept/shared";
import { NextResponse } from "next/server";

import { publishPage, type PublisherContext } from "../../../lib/publish/pipeline";

/**
 * Node, not edge: `postgres-js` needs TCP sockets and `aws4fetch` signs with
 * Node's crypto. The SERVING path is 100% Cloudflare and untouched by this —
 * the control plane running on Railway is the whole point of the split.
 */
export const runtime = "nodejs";

/** Every publish mutates four stores; nothing about it is cacheable. */
export const dynamic = "force-dynamic";

/** JSON body, multipart form, or a raw HTML payload. */
const JSON_TYPE = "application/json";
const MULTIPART_TYPE = "multipart/form-data";
const HTML_TYPE = "text/html";

class UnreadableBodyError extends Error {}

/** Multipart values arrive as `null` when absent; the schema wants `undefined`. */
function optionalField(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Extract the request body into the shape `publishRequestSchema` validates.
 * Three content types, one shape:
 *
 * - `application/json` — `{ html, turnstileToken?, reminderEmail? }`, the PRD's
 *   canonical body and what the hero and E08 send.
 * - `multipart/form-data` — the same fields; `html` may be a file part, which
 *   is what a dropped `.html` file is.
 * - `text/html` — the raw document as the whole body. Kept deliberately small
 *   and deliberately present: it is the difference between the epic's
 *   "`curl -X POST` with an HTML body" acceptance case working literally and
 *   requiring the caller to JSON-encode a document first.
 */
async function readBody(request: Request): Promise<unknown> {
  const contentType = (request.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();

  if (contentType === JSON_TYPE) {
    try {
      return await request.json();
    } catch {
      throw new UnreadableBodyError("The body is not valid JSON.");
    }
  }

  if (contentType === MULTIPART_TYPE) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new UnreadableBodyError("The multipart body could not be parsed.");
    }
    const html = form.get("html");
    return {
      html: html instanceof File ? await html.text() : (optionalField(html) ?? ""),
      turnstileToken: optionalField(form.get("turnstileToken")),
      reminderEmail: optionalField(form.get("reminderEmail")),
    };
  }

  if (contentType === HTML_TYPE) {
    return { html: await request.text() };
  }

  throw new UnreadableBodyError(
    `Unsupported content type "${contentType || "(none)"}". Send ${JSON_TYPE}, ${MULTIPART_TYPE} or ${HTML_TYPE}.`,
  );
}

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

function errorResponse(status: number, body: PublishError): NextResponse {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  // Machine-readable AND transport-standard: agents are the primary caller and
  // an error they cannot act on is an infinite retry loop.
  if (body.retry_after_seconds !== undefined) {
    headers["retry-after"] = String(body.retry_after_seconds);
  }
  return NextResponse.json(publishErrorSchema.parse(body), { status, headers });
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readBody(request);
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
