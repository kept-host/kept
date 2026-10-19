/**
 * `POST /api/reports` — anyone reports a page (E07 D10, §6.8). Body
 * `{ url, category, details, name?, email?, goodFaith: true, turnstileToken }`.
 * The decisions are `lib/reports/submit.ts`'s; this is the HTTP boundary.
 *
 * Answers on open and closed deploys alike (`CLOSED_API_PATHS`). No session
 * and no origin gate: it reads no cookie and writes a report nobody owns;
 * Turnstile and the per-IP limits are its guard.
 */
import { readJsonOnlyBody, UnreadableBodyError } from "../../../lib/publish/http";
import { clientIp } from "../../../lib/rate-limit";
import { reportRefusal, reportResponse } from "../../../lib/reports/http";
import { submitReport } from "../../../lib/reports/submit";

/** `postgres-js` needs TCP sockets, and Resend's SDK is a node client. */
export const runtime = "nodejs";

/** Writes a row and may send mail. Never cacheable. */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await readJsonOnlyBody(request);
  } catch (err) {
    if (err instanceof UnreadableBodyError) return reportRefusal("invalid");
    throw err;
  }
  return reportResponse(await submitReport(body, clientIp(request)));
}
