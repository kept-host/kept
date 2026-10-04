/**
 * When did the export download begin? — E06 task 013 (PRD §5.7: Settings shows
 * "Preparing…" until the download begins).
 *
 * The export is a native browser download (D13): the zip streams from R2
 * straight to disk, and nothing about it is ever held in the tab. The cost is
 * that a page cannot observe a download — there is no event for "the browser
 * got the response". So the response says so itself: the settings button puts a
 * one-off token in the URL, and `GET /api/export` answers with a short-lived
 * cookie carrying that token and whether the export started. The cookie arrives
 * with the response's headers, which is exactly when the browser starts the
 * download; the button polls `document.cookie` for it.
 *
 * Not a credential and not trusted for anything: the worst a forged value can do
 * is end a "Preparing…" early. Hence readable by script, and scoped to
 * `/settings`, the one page that reads it.
 *
 * Browser-safe on purpose — the route and the client island both import it.
 */

/** The query parameter carrying the button's token. */
export const EXPORT_READY_PARAM = "ready";

/** The cookie the export route answers with. */
export const EXPORT_READY_COOKIE = "kept-export-ready";

/** Where the cookie is visible: the settings screen, and nowhere else. */
export const EXPORT_READY_PATH = "/settings";

/** Long enough for the poll to see it; short enough to leave nothing behind. */
export const EXPORT_READY_MAX_AGE_SECONDS = 60;

/** Did the export's response start a zip, or refuse? */
export type ExportStart = "started" | "failed";

/** The shape a token may take (`crypto.randomUUID()`), so a cookie value stays inert. */
const TOKEN = /^[0-9a-f-]{36}$/;

/** The token from the request, or `null` when there is none or it is not one. */
export function exportReadyToken(value: string | null): string | null {
  return value !== null && TOKEN.test(value) ? value : null;
}

/** The cookie value for `token`'s answer. */
export function exportReadyValue(token: string, start: ExportStart): string {
  return `${token}.${start}`;
}

/** What `document.cookie` says about `token`'s export: started, failed, or nothing yet. */
export function readExportStart(cookies: string, token: string): ExportStart | null {
  for (const pair of cookies.split(";")) {
    const [name, value] = pair.trim().split("=");
    if (name !== EXPORT_READY_COOKIE) continue;
    if (value === exportReadyValue(token, "started")) return "started";
    if (value === exportReadyValue(token, "failed")) return "failed";
  }
  return null;
}
