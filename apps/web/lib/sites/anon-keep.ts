/**
 * The anonymous→owned door — E05 task 008. `POST /api/anon/:anonToken/keep`.
 *
 * A bearer token in one hand, a session in the other: whoever holds the claim
 * link kept handed the publisher can attach that page to THEIR account. It is
 * the only place in the codebase that calls `keepSite` with
 * `expectAnonymous: true`.
 *
 * NO HTTP IN THIS FILE, the same split `../publish/anon-manage.ts` uses: the
 * route handler above knows about `Request` objects and status codes, `./keep.ts`
 * owns the cap rule, the status rules, the transactions and the late keep's
 * manifest write, `../publish/anon-token.ts` owns the 404 shape — and this
 * module composes them. That is also what lets the drills run with no server,
 * because `next/headers` throws outside a request scope.
 *
 * ── THREE BRANCHES, ONE OF WHICH IS EXPENSIVE (all in `keepSite`) ───────────
 *
 *   status 'live', under cap    → `kept`                       POSTGRES ONLY
 *   status 'live', at cap       → `owned_draft`                POSTGRES ONLY
 *   status 'expired', in grace  → `live` again, then after COMMIT
 *                                 writeManifest(slug, …)       pointer → KV →
 *                                                              purge → purge+125s
 *
 * The ordinary keep does NOT write a manifest and does NOT purge — see the
 * header of `./keep.ts` for why writing it "for consistency" is a regression.
 * The restore is the one place that cost is worth paying: the manifest was
 * REMOVED when the draft expired, so the edge is currently serving "gone" and
 * only a KV write brings the page back. E06 task 004 moved that sequence into
 * `./keep.ts` so the owner door and the swap run the very same one.
 *
 * ── THE RESOLVER DOES NOT DO WHAT IT LOOKS LIKE IT DOES ────────────────────
 * `resolveAnonToken(token)` defaults to `requireLive: true` and returns `null`
 * for EVERY non-`live` status — including an `expired` row one hour into a
 * thirty-day grace window, which is precisely the row this endpoint exists to
 * rescue. So it is called with `requireLive: false`, which also admits
 * `archived`, `removed`, `quarantined` and `under_review`. None of those may ever
 * be keepable: keeping a moderated page would hand an attacker a permanent home
 * for content that was taken down, and resurrecting an archived one is not a
 * flow that exists. `keepSite` refuses every one of them — and an `expired` row
 * past `purge_after` — from the row it reads UNDER THE OWNER LOCK, so a sweep
 * that moves the row between the token lookup and the keep cannot slip one
 * through. There is still exactly ONE resolver and ONE status rule.
 *
 * ── ONE 404, INDISTINGUISHABLE ─────────────────────────────────────────────
 * Unknown token, malformed token, a moderated status, a row past `purge_after`,
 * and an already-kept page (whose `anon_token_hash` is null, so its token no
 * longer resolves) all produce the byte-identical `notFound()` body. A
 * distinguishable answer turns a token guess into a probe for whether somebody
 * else's page exists. Task 009's screen says "this page has already been kept"
 * from its own context, never from a distinguishable API response.
 *
 * The token is never logged, never echoed into a body and never put in a
 * redirect target; the failure logs below name the slug and the site id, which
 * diagnose everything and grant nothing.
 */
import { keepResultSchema } from "@kept/shared";
import { z } from "zod";

import type { AnonSite } from "../db/queries/publish";
import type { AnonOutcome } from "../publish/anon-manage";
import { notFound, resolveAnonToken } from "../publish/anon-token";
import { fail, liveUrl, type PublishFailure } from "../publish/pipeline";
import { keepSite, type KeepSiteResult } from "./keep";
import { StudioRefusal } from "./studio-refusal";

/**
 * What a keep answers with: `KeepSiteResult` — `KeepResult`, so a client parses
 * ONE shape whether it came through this route or the owner route, plus
 * `restored` — and `liveUrl`, the one thing only the anonymous path needs.
 *
 * `liveUrl` is here because the whole promise of a late keep is *your page is
 * back at the same address*, and the anonymous caller has no dashboard to look
 * it up in. `restored` is what lets task 009 say "back online" instead of
 * "kept" without re-deriving it from a status the response does not carry.
 */
export type AnonKeepResponse = KeepSiteResult & { liveUrl: string };

export const anonKeepResponseSchema = z.intersection(
  keepResultSchema,
  z.object({ liveUrl: z.string().url(), restored: z.boolean() }),
);

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function success(result: KeepSiteResult, slug: string): AnonOutcome<AnonKeepResponse> {
  // Parse our own output: task 009's screen and E06's dashboard both branch on
  // `outcome` and read `quota` without a second request, so a silent shape
  // change here is a broken screen rather than a failed test.
  return {
    ok: true,
    status: 200,
    body: anonKeepResponseSchema.parse({ ...result, liveUrl: liveUrl(slug) }),
  };
}

/**
 * Nobody is signed in, so the token cannot be attached to anyone. 401 in the
 * flat `PublishError` shape every `/api/anon/*` route answers with — NOT the
 * studio envelope `lib/sites/owner-routes.ts` uses for the same status, because
 * this prefix's bodies are frozen. The route answers it before the token is read.
 */
export function signedOut(): PublishFailure {
  return fail(401, { error: "invalid_request", message: "Sign in to manage this page." });
}

/** An unexpected throw. Logged with the site, answered without detail. */
function unexpected(site: AnonSite, err: unknown) {
  console.error(
    `[kept] anon keep: failed unexpectedly for site ${site.id} (slug "${site.slug}") — ${message(err)}`,
  );
  return fail(500, {
    error: "internal_error",
    message:
      "kept could not keep this page. Nothing was left half-written — retry the request.",
  });
}

/**
 * Attach the page a bearer token names to the signed-in account.
 *
 * `profileId` comes from the caller's session (`getProfileForSession`), never
 * from the request body: the token says *which page*, the session says *whose
 * account*, and neither may stand in for the other.
 *
 * AT THE CAP THIS IS STILL A SUCCESS. `keepSite`'s anonymous door returns
 * `owned_draft`: the page is owned, its token is dead, its countdown is intact
 * (fresh, if it had expired) and the quota rides along so the caller can render
 * the swap prompt. There is no 4xx for being at the account's kept limit on this
 * door, and there must never be one — "publishing past the cap lands as a draft,
 * never a hard error", applied to keeping.
 */
export async function keepAnonymousPage(
  token: string,
  profileId: string,
): Promise<AnonOutcome<AnonKeepResponse>> {
  const site = await resolveAnonToken(token, { requireLive: false });
  if (!site) return notFound();

  try {
    return success(await keepSite(site.id, profileId, { expectAnonymous: true }), site.slug);
  } catch (err) {
    if (!(err instanceof StudioRefusal)) return unexpected(site, err);

    if (err.code === "internal_error") {
      // The late keep could not be completed — no contents to restore, or the
      // manifest write failed after Postgres committed. Reported honestly, in
      // the frozen flat shape, with the refusal's own sentence: "kept, but not
      // back online yet" is not a bare "try again".
      if (err.detail) console.error(`[kept] anon keep: ${err.detail}`);
      return fail(500, { error: "internal_error", message: err.message });
    }

    // Owned by somebody ELSE, ended, past grace, or a moderated status — the
    // same 404 as a token that names nothing, because "this token points at a
    // real page you may not have" is an oracle.
    return notFound();
  }
}
