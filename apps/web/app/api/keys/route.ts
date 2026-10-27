/**
 * `GET /api/keys` — the signed-in account's live API keys.
 * `POST /api/keys` `{ name }` — mint one; the raw key is in this response and
 * never again (E09 D6).
 *
 * Session authority over the caller's own account: there is no id naming whose
 * keys these are. `POST` is origin-gated first — a script on a hosted page must
 * not mint a key on its visitor's account (E05a, `lib/publish/origin.ts`).
 *
 * THIS FILE IS THE HTTP BOUNDARY AND NOTHING ELSE; the key lifecycle is
 * `lib/agents/keys.ts`.
 */
import { API_KEY_LIMIT_MESSAGE, apiKeyCreatedSchema } from "@kept/shared";
import type { NextResponse } from "next/server";

import { createKey, createKeyRequestSchema, listKeys } from "../../../lib/agents/keys";
import { getSession } from "../../../lib/auth/session";
import { getProfileForSession } from "../../../lib/db/queries/profile";
import { readJsonOnlyBody, UnreadableBodyError } from "../../../lib/publish/http";
import { refuseUntrustedOrigin } from "../../../lib/publish/origin";
import { ownerResponse, refuse, signedOut } from "../../../lib/sites/owner-routes";

/** `postgres-js` needs TCP sockets. */
export const runtime = "nodejs";

/** Per-account and session-bound. Never cacheable. */
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const profile = await getProfileForSession(await getSession());
  if (!profile) return ownerResponse(signedOut());
  return ownerResponse({ ok: true, status: 200, body: { keys: await listKeys(profile.id) } });
}

export async function POST(request: Request): Promise<NextResponse> {
  const foreign = refuseUntrustedOrigin(request);
  if (foreign) return foreign;

  const profile = await getProfileForSession(await getSession());
  if (!profile) return ownerResponse(signedOut());

  let body: unknown;
  try {
    body = await readJsonOnlyBody(request);
  } catch (err) {
    if (err instanceof UnreadableBodyError) {
      return ownerResponse(refuse("invalid_request", err.message));
    }
    throw err;
  }
  const parsed = createKeyRequestSchema.safeParse(body);
  if (!parsed.success) {
    return ownerResponse(refuse("invalid_request", "Name the key: 1 to 60 characters."));
  }

  const created = await createKey(profile.id, parsed.data.name);
  if (!created) {
    return ownerResponse(refuse("key_limit_reached", API_KEY_LIMIT_MESSAGE));
  }
  return ownerResponse({
    ok: true,
    status: 201,
    body: apiKeyCreatedSchema.parse({ ...created.summary, api_key: created.apiKey }),
  });
}
