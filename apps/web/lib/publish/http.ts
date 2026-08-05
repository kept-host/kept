/**
 * The HTTP boundary bits every publish-family route shares — body extraction
 * and the error response — so `POST /api/publish` and the three anonymous
 * manage routes read a body exactly one way and fail exactly one way.
 *
 * Extracted from `app/api/publish/route.ts` when task 006 added replace, which
 * accepts the identical three content types for the identical reason: a dropped
 * `.html` file arrives as multipart, a pasted document as JSON, and a `curl`
 * user should not have to JSON-encode a document to use the API.
 */
import { publishErrorSchema, type PublishError } from "@kept/shared";
import { NextResponse } from "next/server";

const JSON_TYPE = "application/json";
const MULTIPART_TYPE = "multipart/form-data";
const HTML_TYPE = "text/html";

/** A body that could not be read at all — distinct from one that failed zod. */
export class UnreadableBodyError extends Error {}

/** Multipart values arrive as `null` when absent; the schemas want `undefined`. */
function optionalField(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function contentTypeOf(request: Request): string {
  return (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new UnreadableBodyError("The body is not valid JSON.");
  }
}

/**
 * Extract a page-bearing body into the shape the publish/replace schemas
 * validate. Three content types, one shape:
 *
 * - `application/json` — `{ html, turnstileToken?, reminderEmail? }`, the PRD's
 *   canonical body and what the hero and E08 send.
 * - `multipart/form-data` — the same fields; `html` may be a file part, which
 *   is what a dropped `.html` file is.
 * - `text/html` — the raw document as the whole body, so the epic's
 *   "`curl -X POST` with an HTML body" case works literally.
 */
export async function readPageBody(request: Request): Promise<unknown> {
  const contentType = contentTypeOf(request);

  if (contentType === JSON_TYPE) return readJson(request);

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
