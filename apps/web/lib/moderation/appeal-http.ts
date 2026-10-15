/**
 * The HTTP shape of the two appeal routes (E07 §6.10) — validation and
 * result→response mapping only; every decision is `./appeals.ts`'s.
 *
 *   POST /api/sites/:id/appeal     session + origin check (the route), owner-scoped SQL
 *   POST /api/anon/:token/appeal   the bearer token; no origin check (E05a)
 *
 * Both answer `appealErrorSchema`'s envelope: `201` · `400 invalid` ·
 * `404 not_found` · `409 not_restricted` · `409 appeal_open` · `429 rate_limited`.
 *
 * "Not yours", "does not exist" and a malformed id are ONE 404, byte-identical
 * (D17: never 403). The token route keeps the anonymous path's uniform 404 for
 * an unknown, archived, expired or purged page; the token holder manages the
 * page, so telling them it is restricted is not an oracle (§6.10).
 */
import {
  APPEAL_MESSAGE_MAX,
  APPEAL_MESSAGE_MIN,
  appealErrorSchema,
  appealRequestSchema,
  appealResultSchema,
  type AppealErrorCode,
} from "@kept/shared";
import { NextResponse } from "next/server";

import { resolveAnonToken } from "../publish/anon-token";
import { siteIdSchema } from "../sites/owner-routes";

import { submitAppeal, type SubmitAppealResult } from "./appeals";

const STATUS: Record<AppealErrorCode, number> = {
  invalid: 400,
  not_found: 404,
  not_restricted: 409,
  appeal_open: 409,
  rate_limited: 429,
};

const MESSAGES: Record<AppealErrorCode, string> = {
  invalid: `Tell us in ${APPEAL_MESSAGE_MIN} to ${APPEAL_MESSAGE_MAX} characters why the page should come back.`,
  not_found: "No page matches this link. It may have been deleted, or the link may be wrong.",
  not_restricted: "This page isn't hidden or removed, so there's nothing to review.",
  appeal_open: "We've got your request — we'll email you.",
  rate_limited: "You've asked for a review of this page several times recently. Try again later.",
};

const NO_STORE = { "cache-control": "no-store" };

/** A refusal, in the one envelope. */
export function appealRefusal(code: AppealErrorCode, retryAfterSeconds?: number): NextResponse {
  const body = appealErrorSchema.parse({
    error: { code, message: MESSAGES[code] },
    ...(retryAfterSeconds ? { retry_after_seconds: retryAfterSeconds } : {}),
  });
  return NextResponse.json(body, {
    status: STATUS[code],
    headers: retryAfterSeconds ? { ...NO_STORE, "retry-after": String(retryAfterSeconds) } : NO_STORE,
  });
}

function respond(result: SubmitAppealResult): NextResponse {
  if (!result.ok) {
    return appealRefusal(result.refusal, result.refusal === "rate_limited" ? result.retryAfterSeconds : undefined);
  }
  const body = appealResultSchema.parse({
    appeal: { id: result.appealId, status: "open", createdAt: result.createdAt.toISOString() },
  });
  return NextResponse.json(body, { status: 201, headers: NO_STORE });
}

/** `POST /api/sites/:id/appeal`, after the origin gate and the session. */
export async function appealOwnedSite(rawSiteId: string, raw: unknown, profileId: string): Promise<NextResponse> {
  const siteId = siteIdSchema.safeParse(rawSiteId);
  if (!siteId.success) return appealRefusal("not_found");
  const body = appealRequestSchema.safeParse(raw);
  if (!body.success) return appealRefusal("invalid");
  return respond(await submitAppeal(siteId.data, body.data.message, profileId));
}

/** `POST /api/anon/:token/appeal`, after the closed-mode gate. */
export async function appealAnonSite(token: string, raw: unknown): Promise<NextResponse> {
  const site = await resolveAnonToken(token, { requireLive: false });
  // The anonymous path's uniform 404: archived and expired pages are not the
  // token holder's to appeal; `submitAppeal` adds "past purge_after".
  if (!site || site.status === "archived" || site.status === "expired") return appealRefusal("not_found");
  const body = appealRequestSchema.safeParse(raw);
  if (!body.success) return appealRefusal("invalid");
  return respond(await submitAppeal(site.id, body.data.message, null));
}
