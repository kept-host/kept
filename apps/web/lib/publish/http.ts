/**
 * The HTTP boundary bits every publish-family route shares — body parsing
 * helpers and the error response — so `POST /api/publish` and the anonymous
 * manage routes read a body exactly one way and fail exactly one way. A page's
 * body is read by `./fileset/read.ts` (`readFileSet`, E08 D3), on these helpers:
 * a dropped file arrives as multipart, a pasted document as JSON, and a `curl`
 * user should not have to JSON-encode a document to use the API.
 */
import { publishErrorSchema, type PublishError } from "@kept/shared";
// `.js`: see the same import in `./hooks.ts` (Playwright's ESM loader).
import { NextResponse } from "next/server.js";

import type { PublisherContext } from "./pipeline";

export const JSON_TYPE = "application/json";
export const MULTIPART_TYPE = "multipart/form-data";
export const HTML_TYPE = "text/html";

/** A body that could not be read at all — distinct from one that failed zod. */
export class UnreadableBodyError extends Error {}

/** Multipart values arrive as `null` when absent; the schemas want `undefined`. */
export function optionalField(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The media type alone, lowercased — no `boundary` or `charset` parameter. */
export function contentTypeOf(request: Request): string {
  return (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
}

/** A JSON body, or `UnreadableBodyError`. Takes any `Body` — the file-set reader parses a bounded copy. */
export async function readJson(body: Pick<Body, "json">): Promise<unknown> {
  try {
    return await body.json();
  } catch {
    throw new UnreadableBodyError("The body is not valid JSON.");
  }
}

/** The refusal for a body in none of the three page-bearing content types. */
export function unsupportedContentType(contentType: string): UnreadableBodyError {
  return new UnreadableBodyError(
    `Unsupported content type "${contentType || "(none)"}". Send ${JSON_TYPE}, ${MULTIPART_TYPE} or ${HTML_TYPE}.`,
  );
}

/**
 * A small JSON body — the reminder endpoint. No multipart branch: it carries one
 * short field, never a file, and a second parser for it would be a second place
 * for the shape to drift.
 */
export async function readJsonOnlyBody(request: Request): Promise<unknown> {
  if (contentTypeOf(request) !== JSON_TYPE) {
    throw new UnreadableBodyError(`Unsupported content type. Send ${JSON_TYPE}.`);
  }
  return readJson(request);
}

/**
 * The publisher's identity for dedup and E07's rate limiter.
 *
 * The raw address is read here, handed to the salted hash by the pipeline, and
 * then dropped: it is never stored, never logged and never returned. Railway
 * (and any proxy in front of it) sets `x-forwarded-for`; the first entry is the
 * client.
 *
 * Shared by the KEYLESS publish and the OWNED one (E06 task 004) — two routes
 * with two authority models, but the same one question about the transport, and
 * `publisher_hash` must mean the same thing on both or E07's governors are
 * counting two different populations.
 */
export function publisherFrom(request: Request): PublisherContext {
  return {
    ip: forwardedIp(request),
    userAgent: request.headers.get("user-agent") ?? "",
  };
}

/**
 * The client address the origin's proxy forwards: the first `x-forwarded-for`
 * entry, then `x-real-ip`, else `"unknown"`. `lib/rate-limit/client-ip.ts`
 * prefers Cloudflare's `CF-Connecting-IP` and falls back to this.
 */
export function forwardedIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real = request.headers.get("x-real-ip")?.trim();
  return forwarded || real || "unknown";
}

/**
 * Which door an anonymous replace came through (`site_versions.published_via`,
 * PRD §5.9): `web` when the browser itself says the request came from the app's
 * own origin — the `/p/:token` manage screen — and `api` for everyone else.
 *
 * `Sec-Fetch-Site` is a forbidden header name: a page script cannot set it and
 * the browser computes it from the true initiator, so `same-origin` cannot be
 * claimed by a `curl`. It labels a row; it authorises nothing — the bearer
 * token in the path is still the whole of the authority, and this route stays
 * free of the cookie routes' origin gate.
 */
export function browserChannel(request: Request): "web" | "api" {
  return request.headers.get("sec-fetch-site") === "same-origin" ? "web" : "api";
}

/**
 * The one error response. `retry_after_seconds` is mirrored into the standard
 * header because agents are the primary caller and an error they cannot act on
 * is an infinite retry loop.
 *
 * The anon token is never in `body` — it is a bearer credential and an error
 * body is the easiest thing in a system to end up in a log.
 */
export function errorResponse(status: number, body: PublishError): NextResponse {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (body.retry_after_seconds !== undefined) {
    headers["retry-after"] = String(body.retry_after_seconds);
  }
  return NextResponse.json(publishErrorSchema.parse(body), { status, headers });
}
