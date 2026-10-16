/**
 * `GET /api/admin/moderation/sites/:id/source` — the page's current HTML, as
 * `text/plain`, for the moderation screen's "Show" (E07 D13, AC39 admin half).
 *
 * A child-sexual-abuse item's bytes are never part of the item view's render;
 * they leave the server only through this round-trip (or `../preview`), with
 * `?show=1`, when Arun asks. `text/plain` + `nosniff` + an inert `sandbox` CSP:
 * opened directly, the bytes are text, never a document on `app.`. Admin
 * session; anyone else gets 404. A read, so no origin check: a cross-origin
 * page cannot read the answer (no CORS).
 */
import type { NextResponse } from "next/server";

import { adminSessionFor } from "../../../../../../../lib/auth/admin";
import { adminNotFound, adminPageResponse } from "../../../../../../../lib/moderation/admin-http";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Depends on the session cookie. Never cacheable. */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!(await adminSessionFor(request))) return adminNotFound();
  return adminPageResponse(request, (await params).id, {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "cache-control": "no-store",
  });
}
