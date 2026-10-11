/**
 * `POST /api/waitlist/unsubscribe` — leave the waitlist (E06a §3, AC11).
 *
 * Two bodies, one effect (`unsubscribed_at`; the row stays):
 *   - `{ token }` as JSON, from a page;
 *   - RFC 8058 one-click: the mail client POSTs the `List-Unsubscribe` URL
 *     (`?t=…`) with the form body `List-Unsubscribe=One-Click`
 *     (`waitlistUnsubscribe` in `lib/email/waitlist.ts` builds it).
 *
 * Always 200 `{ status: "unsubscribed" }`, signed token or not: a different
 * answer would make this URL an oracle for who is on the list.
 */
import { NextResponse } from "next/server";

import { unsubscribeWaitlist } from "../../../../lib/waitlist/unsubscribe";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Writes a row. Never cacheable. */
export const dynamic = "force-dynamic";

async function tokenOf(request: Request): Promise<unknown> {
  const fromQuery = new URL(request.url).searchParams.get("t");
  if (fromQuery) return fromQuery;
  if ((request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    const body: unknown = await request.json().catch(() => null);
    return body && typeof body === "object" && "token" in body ? body.token : undefined;
  }
  return undefined;
}

export async function POST(request: Request): Promise<NextResponse> {
  await unsubscribeWaitlist(await tokenOf(request));
  return NextResponse.json(
    { status: "unsubscribed" },
    { status: 200, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
  );
}
