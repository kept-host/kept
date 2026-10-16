/**
 * `GET /api/admin/moderation/sites/:id/source` — the page's current HTML, as
 * `text/plain`, for the moderation screen's "Show" (E07 D13, AC39 admin half).
 *
 * A child-sexual-abuse item's bytes are never part of the item view's render;
 * they leave the server only through this round-trip, when Arun asks. `text/plain`
 * + `nosniff` + an inert `sandbox` CSP: opened directly, the bytes are text,
 * never a document on `app.`. Admin session; anyone else gets 404. A read, so no
 * origin check: a cross-origin page cannot read the answer (no CORS).
 */
import { NextResponse } from "next/server";

import { adminSessionFor } from "../../../../../../../lib/auth/admin";
import { sourceSubject } from "../../../../../../../lib/db/queries/moderation-screen";
import { readAdminHtml } from "../../../../../../../lib/moderation/admin";
import { adminNotFound } from "../../../../../../../lib/moderation/admin-http";
import { siteIdSchema } from "../../../../../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Depends on the session cookie. Never cacheable. */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const admin = await adminSessionFor(request);
  if (!admin) return adminNotFound();

  const siteId = siteIdSchema.safeParse((await params).id);
  if (!siteId.success) return adminNotFound();
  const site = await sourceSubject(siteId.data);
  const html = site ? await readAdminHtml(site) : null;
  if (html === null) return adminNotFound();

  return new NextResponse(html, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "cache-control": "no-store",
    },
  });
}
