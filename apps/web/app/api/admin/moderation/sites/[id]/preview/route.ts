/**
 * `GET /api/admin/moderation/sites/:id/preview` — the page's current HTML as a
 * document, for the item view's Preview iframe (E07 D12, §6.11, D-69).
 *
 * Its own route because a `srcdoc` frame inherits the `/admin/*` CSP and a
 * `<meta>` policy can only tighten it, so the page's scripts never ran. This
 * response carries `ADMIN_PREVIEW_CSP` instead (`lib/routing/admin-csp.ts`):
 * `sandbox allow-scripts` — an opaque origin even when opened top-level, so no
 * `app.` cookie and no reach into the admin window — inline script and style
 * only, and no network, so the reviewer's IP never reaches the page's author.
 * The middleware sets no policy on `/api/*`, so this one is the only one.
 *
 * Admin session; anyone else gets 404. A child-sexual-abuse item needs `?show=1`
 * (D13). A read, so no origin check: a cross-origin page cannot read it (no CORS).
 */
import type { NextResponse } from "next/server";

import { adminSessionFor } from "../../../../../../../lib/auth/admin";
import { adminNotFound, adminPageResponse } from "../../../../../../../lib/moderation/admin-http";
import { ADMIN_PREVIEW_CSP } from "../../../../../../../lib/routing/admin-csp";

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
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": ADMIN_PREVIEW_CSP,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
}
