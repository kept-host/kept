/**
 * The HTTP shape of `/api/admin/moderation/*` (E07 §6.11) — body validation and
 * result→response mapping only; every decision is `./admin.ts`'s.
 *
 * Each route, in order: `refuseUntrustedOrigin` (mutations), then
 * `adminSessionFor` — anyone else gets `adminNotFound()`, the bare 404 the
 * middleware answers for a path it refuses, never a 403 (AC20) — then this.
 *
 * Answers: `200 { ok: true, … }` · `400 invalid` · `404 not_found` (an admin
 * naming nothing) · `409 <refusal>` with the refusal's admin-facing message.
 */
import { NextResponse } from "next/server";
import type { z } from "zod";

import { readJsonOnlyBody, UnreadableBodyError } from "../publish/http";
import { siteIdSchema } from "../sites/owner-routes";

import { decideAppeal, dismissReports, moderateSite } from "./admin";
import { appealDecisionSchema, dismissReportsSchema, siteActionSchema } from "./admin-rules";
import type { SetStatusResult } from "./status";

const NO_STORE = { "cache-control": "no-store" };

/** The one answer for anyone but an admin, and for a malformed admin path. */
export function adminNotFound(): NextResponse {
  return new NextResponse(null, { status: 404 });
}

function refusal(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers: NO_STORE });
}

function done(body: Record<string, unknown>): NextResponse {
  return NextResponse.json({ ok: true, ...body }, { headers: NO_STORE });
}

/** Read and validate a JSON body; a `NextResponse` when it is unusable. */
async function parseBody<S extends z.ZodTypeAny>(request: Request, schema: S): Promise<z.infer<S> | NextResponse> {
  let raw: unknown;
  try {
    raw = await readJsonOnlyBody(request);
  } catch (err) {
    if (err instanceof UnreadableBodyError) return refusal(400, "invalid", err.message);
    throw err;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return refusal(400, "invalid", parsed.error.issues.map((issue) => issue.message).join(" "));
  }
  return parsed.data;
}

function statusRefusal(result: Extract<SetStatusResult, { ok: false }>): NextResponse {
  return refusal(result.refusal === "not_found" ? 404 : 409, result.refusal, result.message);
}

/** `POST /api/admin/moderation/sites/:id` — Restore, Hide or Remove. */
export async function siteActionResponse(rawId: string, request: Request, adminUserId: string): Promise<NextResponse> {
  const siteId = siteIdSchema.safeParse(rawId);
  if (!siteId.success) return adminNotFound();
  const body = await parseBody(request, siteActionSchema);
  if (body instanceof NextResponse) return body;

  const { status, reports } = await moderateSite(siteId.data, body, adminUserId);
  if (!status.ok) return statusRefusal(status);
  return done({
    from: status.from,
    to: status.to,
    manifest: status.manifest.ok ? "synced" : "pending",
    statement: status.statement,
    reports,
  });
}

/** `POST /api/admin/moderation/reports` — dismiss reports. */
export async function dismissReportsResponse(request: Request, adminUserId: string): Promise<NextResponse> {
  const body = await parseBody(request, dismissReportsSchema);
  if (body instanceof NextResponse) return body;
  return done({ reports: await dismissReports(body.reportIds, body.note, adminUserId) });
}

/** `POST /api/admin/moderation/appeals/:id` — grant or reject. */
export async function appealDecisionResponse(
  rawId: string,
  request: Request,
  adminUserId: string,
): Promise<NextResponse> {
  const appealId = siteIdSchema.safeParse(rawId);
  if (!appealId.success) return adminNotFound();
  const body = await parseBody(request, appealDecisionSchema);
  if (body instanceof NextResponse) return body;

  const decided = await decideAppeal(appealId.data, body, adminUserId);
  if (decided.decision === "grant") {
    const result = decided.result;
    if (!result.ok) return statusRefusal(result);
    return done({ decision: "grant", to: result.to, statement: result.statement });
  }
  const result = decided.result;
  if (!result.ok) {
    return result.refusal === "note_required"
      ? refusal(400, "invalid", "Write the reason.")
      : refusal(409, "appeal_not_open", "That appeal is not open any more.");
  }
  return done({ decision: "reject", statement: result.statement });
}
