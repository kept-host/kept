/**
 * The browser's client for `POST /api/publish` — the hero's half of the
 * contract, and the only place in the app that knows the endpoint's URL.
 *
 * THE API IS THE PRODUCT: this module adds nothing to it. It serializes the
 * request the route already accepts, parses the response with the SAME zod
 * schemas the route answers with (`@kept/shared`), and hands back a
 * discriminated result. No retries, no state, no DOM — `kept-engine.ts` owns
 * the phases, this owns the wire.
 *
 * The pre-flight checks below are a COURTESY, not a gate. They exist so an
 * obviously-oversized or obviously-wrong file fails in a millisecond instead of
 * after a 5 MB upload; the server validates every byte again and is the only
 * authority. They share `MAX_PAGE_BYTES` with it, so the two can never disagree
 * about where the limit is.
 */
import {
  MAX_PAGE_BYTES,
  publishErrorSchema,
  publishResponseSchema,
  type PublishError,
  type PublishRequest,
  type PublishResponse,
} from "@kept/shared";

/** A publish attempt: the minted page, or an error from the closed enum. */
export type PublishOutcome =
  | { ok: true; page: PublishResponse }
  | { ok: false; error: PublishError };

const BYTES_PER_MB = 1024 * 1024;

/** The size cap in the units a human reads, derived — never a second literal. */
const sizeLimitLabel = () =>
  `${Math.round(MAX_PAGE_BYTES / BYTES_PER_MB)} MB`;

/** `.html` / `.htm` / `.xhtml`, for the browsers that hand over an empty type. */
const HTML_FILE_NAME = /\.(x?html?)$/i;

/**
 * Enough of a tag to be markup. Used only to decide whether a *paste* or a
 * dropped text selection was meant for kept at all — never as validation of a
 * document, which is the server's job. Without it, copying a sentence and
 * hitting ⌘V on the landing page would publish it.
 */
export const LOOKS_LIKE_MARKUP = /<[a-z!/]/i;

/** UTF-8 length: the bytes that actually get uploaded, not the code units. */
function byteLength(html: string): number {
  return new TextEncoder().encode(html).length;
}

/**
 * The one pre-flight check for a chosen/dropped file: type, then size. Returns
 * the error to show, or `null` to proceed.
 */
export function checkPageFile(file: File): PublishError | null {
  const type = file.type.split(";")[0]!.trim().toLowerCase();
  const isHtml = type ? type === "text/html" : HTML_FILE_NAME.test(file.name);
  if (!isHtml) {
    return {
      error: "invalid_request",
      message:
        "kept hosts a single HTML document. Choose a .html file, or paste the markup instead.",
    };
  }
  if (file.size === 0) {
    return { error: "empty_page", message: "That file is empty — there is nothing to keep." };
  }
  if (file.size > MAX_PAGE_BYTES) {
    return {
      error: "page_too_large",
      message: `That page is over the ${sizeLimitLabel()} limit. Inline or trim the largest assets and try again.`,
    };
  }
  return null;
}

/** The same pre-flight for markup that arrived as text (paste, text drop). */
export function checkPageHtml(html: string): PublishError | null {
  const bytes = byteLength(html);
  if (bytes === 0) {
    return { error: "empty_page", message: "There is no markup to keep." };
  }
  if (bytes > MAX_PAGE_BYTES) {
    return {
      error: "page_too_large",
      message: `That page is over the ${sizeLimitLabel()} limit. Inline or trim the largest assets and try again.`,
    };
  }
  return null;
}

/**
 * The message to show a visitor. `retry_after_seconds` is the one field a
 * message can be missing and still be actionable, so it is folded in here —
 * once, rather than at each call site.
 */
export function publishErrorText(error: PublishError): string {
  const seconds = error.retry_after_seconds;
  if (seconds === undefined || error.message.includes(String(seconds))) {
    return error.message;
  }
  return `${error.message} Try again in ${seconds}s.`;
}

function retryAfterHeader(response: Response): number | undefined {
  const raw = Number(response.headers.get("retry-after"));
  return Number.isFinite(raw) && raw >= 0 ? Math.ceil(raw) : undefined;
}

/**
 * Turn a non-201 into a `PublishError`.
 *
 * The route always answers `publishErrorSchema`, so the happy path is a parse.
 * The fallbacks are for responses that never reached the handler at all — a
 * proxy's 413 on an oversized body or a 429 from an edge rate limiter arrive as
 * HTML or as nothing, and a visitor still deserves the right sentence.
 */
async function readError(response: Response): Promise<PublishError> {
  const parsed = publishErrorSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (parsed.success) {
    const error = parsed.data;
    if (error.retry_after_seconds === undefined) {
      const seconds = retryAfterHeader(response);
      if (seconds !== undefined) return { ...error, retry_after_seconds: seconds };
    }
    return error;
  }

  if (response.status === 413) {
    return {
      error: "page_too_large",
      message: `That page is over the ${sizeLimitLabel()} limit. Inline or trim the largest assets and try again.`,
    };
  }
  if (response.status === 429) {
    return {
      error: "rate_limited",
      message: "kept is throttling publishes from here.",
      retry_after_seconds: retryAfterHeader(response) ?? 0,
    };
  }
  return {
    error: "internal_error",
    message: `kept couldn't publish the page (HTTP ${response.status}). Nothing was published — try again.`,
  };
}

/**
 * POST the markup and resolve when the server does — however long that takes.
 *
 * `application/json` because that is the PRD's canonical body and what E08's
 * MCP server sends; the route accepts multipart and raw `text/html` for callers
 * that cannot build JSON, which a browser can.
 *
 * Never throws, including on abort: the caller decides what an aborted request
 * means by reading its own signal.
 */
export async function publishHtml(
  html: string,
  signal?: AbortSignal,
): Promise<PublishOutcome> {
  const body: PublishRequest = { html };
  let response: Response;
  try {
    response = await fetch("/api/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    return {
      ok: false,
      error: {
        error: "internal_error",
        message:
          "kept couldn't be reached. Nothing was published — check your connection and try again.",
      },
    };
  }

  if (response.status !== 201) return { ok: false, error: await readError(response) };

  const parsed = publishResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        error: "internal_error",
        message: "kept answered with something this page could not read. Try again.",
      },
    };
  }
  return { ok: true, page: parsed.data };
}
