import { publishErrorSchema } from "@kept/shared";

/**
 * The browser's client for the three anonymous manage endpoints (task 006).
 *
 * ONE PLACE THAT KNOWS THE URLS AND ONE PLACE THAT READS AN ERROR. The three
 * islands on this screen otherwise each grow their own `fetch` and their own
 * "is there a `message` in this body" dance, which is how three screens end up
 * showing three different sentences for the same 404.
 *
 * `lib/publish/client.ts` is the equivalent for `POST /api/publish` and is
 * deliberately NOT extended to cover these: it parses `publishResponseSchema`,
 * which none of these endpoints return (a replace answers a smaller body, a
 * delete and a reminder answer `{ ok: true }`). What the two share is the ERROR
 * contract, and they share it through `@kept/shared` rather than through each
 * other.
 *
 * THE TOKEN IS A PATH SEGMENT AND IS ENCODED, NEVER A QUERY PARAMETER — the
 * same reasoning as the routes it calls: a bearer credential in a query string
 * lands in access logs and `Referer` headers by default.
 */

/** Success carries nothing; failure carries a sentence the visitor can act on. */
export type ManageResult = { ok: true } | { ok: false; message: string };

const UNREACHABLE =
  "That didn't go through — the request never reached us. Try again.";

function base(anonToken: string): string {
  return `/api/sites/${encodeURIComponent(anonToken)}`;
}

/**
 * The failure sentence for a non-2xx.
 *
 * The routes always answer `publishErrorSchema`, so the happy path is a parse.
 * The fallback covers responses that never reached the handler — a proxy's 413
 * on an oversized upload arrives as HTML, and a visitor still deserves a
 * sentence rather than a status code.
 */
async function errorText(response: Response, fallback: string): Promise<string> {
  const parsed = publishErrorSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) return fallback;

  const { message, retry_after_seconds: seconds } = parsed.data;
  return seconds === undefined || message.includes(String(seconds))
    ? message
    : `${message} Try again in ${seconds}s.`;
}

async function send(
  url: string,
  init: RequestInit,
  fallback: string,
): Promise<ManageResult> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    return { ok: false, message: UNREACHABLE };
  }

  return response.ok
    ? { ok: true }
    : { ok: false, message: await errorText(response, fallback) };
}

const REPLACE_FAILED =
  "That page didn't replace the old one. The published page is unchanged — try again.";

/**
 * Replace with a dropped or chosen file.
 *
 * `multipart/form-data`, because that is what a `File` is: the route accepts an
 * `html` part that may be a file and reads its text server-side, so the browser
 * never has to decode a document just to re-encode it as JSON.
 */
export function replaceWithFile(
  anonToken: string,
  file: File,
): Promise<ManageResult> {
  const form = new FormData();
  form.set("html", file);
  return send(`${base(anonToken)}/replace`, { method: "POST", body: form }, REPLACE_FAILED);
}

/** Replace with pasted markup — JSON, the route's canonical body. */
export function replaceWithHtml(
  anonToken: string,
  html: string,
): Promise<ManageResult> {
  return send(
    `${base(anonToken)}/replace`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html }),
    },
    REPLACE_FAILED,
  );
}

/** Stop serving the page. Archives it; the hard delete is E07's grace-end job. */
export function stopServing(anonToken: string): Promise<ManageResult> {
  return send(
    base(anonToken),
    { method: "DELETE" },
    "The page didn't stop serving. It is still online — try again.",
  );
}

/**
 * Store or clear the pre-expiry reminder address.
 *
 * `""` is the documented "clear it" value; an absent field would be ambiguous
 * between clearing the address and leaving it alone, and a bearer-token endpoint
 * is the wrong place to guess.
 */
export function saveReminder(
  anonToken: string,
  reminderEmail: string,
): Promise<ManageResult> {
  return send(
    `${base(anonToken)}/reminder`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reminderEmail }),
    },
    "That address didn't save. Try again in a moment.",
  );
}
