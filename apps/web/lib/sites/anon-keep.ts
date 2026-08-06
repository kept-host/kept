/**
 * The anonymous→owned door — E05 task 008. `POST /api/anon/:anonToken/keep`.
 *
 * A bearer token in one hand, a session in the other: whoever holds the claim
 * link kept handed the publisher can attach that page to THEIR account. It is
 * the only place in the codebase that calls `keepSite` with
 * `expectAnonymous: true`, and the only place in E05 that touches the edge.
 *
 * NO HTTP IN THIS FILE, the same split `../publish/anon-manage.ts` uses: the
 * route handler above knows about `Request` objects and status codes, `./keep.ts`
 * owns the cap rule and the transactions, `../storage/manifest.ts` owns the KV
 * ordering, `../publish/anon-token.ts` owns the 404 shape — and this module
 * composes them. That is also what lets the drills run with no server, because
 * `next/headers` throws outside a request scope.
 *
 * ── THREE BRANCHES, ONE OF WHICH IS EXPENSIVE ──────────────────────────────
 *
 *   status 'live', under cap    → keepSite → `kept`         POSTGRES ONLY
 *   status 'live', at cap       → keepSite → `owned_draft`  POSTGRES ONLY
 *   status 'expired', in grace  → restoreAndKeepSite, then
 *                                 writeManifest(slug, …)    pointer → KV →
 *                                                           purge → purge+125s
 *
 * The ordinary keep does NOT write a manifest and does NOT purge. Of the six
 * manifest fields, keeping changes exactly one — `ownerId`, null → uuid — and
 * nothing in `apps/edge` reads it: E03 shipped it as forward-looking metadata
 * for E11 region routing, not as serving input. `status` stays `live`, the slug
 * stays, the version stays, and R2 is keyed by `siteId`, so the page the visitor
 * gets is byte-identical before and after. Writing the manifest anyway "for
 * consistency" would burn cache-purge quota and add a failure mode to a flow
 * that currently has none. The manifest is therefore knowingly stale on
 * `ownerId`; see the header of `./keep.ts`.
 *
 * The restore is the one place that cost is worth paying: the manifest was
 * REMOVED when the draft expired, so the edge is currently serving "gone" and
 * only a KV write brings the page back.
 *
 * ── THE RESOLVER DOES NOT DO WHAT IT LOOKS LIKE IT DOES ────────────────────
 * `resolveAnonToken(token)` defaults to `requireLive: true` and returns `null`
 * for EVERY non-`live` status — including an `expired` row one hour into a
 * thirty-day grace window, which is precisely the row this endpoint exists to
 * rescue. So it is called with `requireLive: false` and this module applies its
 * OWN allowlist, because `requireLive: false` also admits `archived`,
 * `removed`, `quarantined` and `under_review`. None of those may ever be
 * keepable: keeping a moderated page would hand an attacker a permanent home
 * for content that was taken down, and resurrecting an archived one is not a
 * flow that exists. There is still exactly ONE resolver — this is a caller-side
 * guard, not a second lookup.
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
import {
  keepResultSchema,
  type KeepResult,
  type KvManifest,
  type SiteStatus,
} from "@kept/shared";
import { z } from "zod";

import type { AnonSite } from "../db/queries/publish";
import type { AnonOutcome } from "../publish/anon-manage";
import { notFound, resolveAnonToken } from "../publish/anon-token";
import { fail, liveUrl } from "../publish/pipeline";
import { writeManifest } from "../storage/manifest";
import { keepSite, restoreAndKeepSite, SiteNotFoundError } from "./keep";

/**
 * What a keep answers with: `KeepResult` — so a client parses ONE shape whether
 * it came through this route or task 010's owner route — plus the two things
 * only the anonymous path can tell the caller.
 *
 * `liveUrl` is here because the whole promise of a late keep is *your page is
 * back at the same address*, and the anonymous caller has no dashboard to look
 * it up in. `restored` is what lets task 009 say "back online" instead of
 * "kept" without re-deriving it from a status the response does not carry.
 */
export type AnonKeepResponse = KeepResult & {
  liveUrl: string;
  /** True only on the late-keep branch: the page had expired and now serves again. */
  restored: boolean;
};

export const anonKeepResponseSchema = z.intersection(
  keepResultSchema,
  z.object({ liveUrl: z.string().url(), restored: z.boolean() }),
);

/**
 * The ONLY two statuses a bearer token may keep.
 *
 * `live` is the ordinary draft. `expired` is a draft whose seven days ran out
 * but whose grace window has not — the late keep. Everything else is a 404:
 * `archived` was deleted by its publisher, `under_review`, `quarantined` and
 * `removed` are moderation states, and keeping any of them would be a way to
 * make a taken-down page permanent.
 */
const KEEPABLE_STATUSES = ["live", "expired"] as const satisfies readonly SiteStatus[];

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Is this row keepable *right now*?
 *
 * `purge_after > now()` is the grace test, and it is the reason `AnonSite` had
 * to be widened: without the column, "expired an hour ago" and "expired two
 * months ago" are the same row. Past `purge_after` the page is awaiting E07's
 * hard delete and is gone as far as anyone outside an audit is concerned.
 */
function keepable(site: AnonSite): boolean {
  if (!(KEEPABLE_STATUSES as readonly SiteStatus[]).includes(site.status)) return false;
  if (site.status !== "expired") return true;
  return site.purgeAfter !== null && site.purgeAfter.getTime() > Date.now();
}

function success(
  result: KeepResult,
  slug: string,
  restored: boolean,
): AnonOutcome<AnonKeepResponse> {
  // Parse our own output: task 009's screen and E06's dashboard both branch on
  // `outcome` and read `quota` without a second request, so a silent shape
  // change here is a broken screen rather than a failed test.
  return {
    ok: true,
    status: 200,
    body: anonKeepResponseSchema.parse({
      ...result,
      liveUrl: liveUrl(slug),
      restored,
    }),
  };
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
 * AT THE CAP THIS IS STILL A SUCCESS. `keepSite` returns `owned_draft`, the
 * page is owned, its token is dead, its countdown is intact and the quota rides
 * along so the caller can render the swap prompt. There is no 4xx for being at
 * `KEPT_PAGE_LIMIT` and there must never be one — "publishing past the cap
 * lands as a draft, never a hard error", applied to keeping.
 */
export async function keepAnonymousPage(
  token: string,
  profileId: string,
): Promise<AnonOutcome<AnonKeepResponse>> {
  const site = await resolveAnonToken(token, { requireLive: false });
  if (!site || !keepable(site)) return notFound();

  if (site.status === "live") {
    try {
      return success(await keepSite(site.id, profileId, { expectAnonymous: true }), site.slug, false);
    } catch (err) {
      // The row is owned by somebody ELSE — the same 404 as a token that names
      // nothing, because "this token points at a real page you may not have"
      // is an oracle.
      if (err instanceof SiteNotFoundError) return notFound();
      return unexpected(site, err);
    }
  }

  return lateKeep(site, profileId);
}

/**
 * The late keep: an `expired` row inside its grace window, brought back.
 *
 * POSTGRES FIRST, THEN THE STORE. `restoreAndKeepSite` flips `status` back to
 * `live` and attaches the page in one transaction; only then is the manifest
 * rewritten. The reverse order would put a page back on the internet that the
 * database still calls expired, and E07's grace sweep would take it down again
 * underneath its new owner.
 *
 * A PURGE IS TWO PURGES — `writeManifest` already schedules the second one 125
 * seconds later (`2 × cacheTtl + 5 s`), because `purge_cache` does not reach the
 * Worker's KV read cache. Do not add a third, do not await the delayed one, and
 * do not reimplement the pointer → KV → purge ordering here; a direct
 * `lib/storage/kv` import is a lint error for exactly this reason.
 */
async function lateKeep(
  site: AnonSite,
  profileId: string,
): Promise<AnonOutcome<AnonKeepResponse>> {
  if (!site.currentVersionId) {
    // No version means no R2 object to point at, so there is no manifest to
    // write and nothing to serve. Not reachable from any path that published
    // successfully; loud rather than silent, because only an audit sees it.
    console.error(
      `[kept] anon keep: site ${site.id} (slug "${site.slug}") is expired with no current version — cannot restore.`,
    );
    return fail(500, {
      error: "internal_error",
      message:
        "kept could not bring this page back — its contents are missing. Nothing was changed.",
    });
  }

  let result: KeepResult;
  try {
    result = await restoreAndKeepSite(site.id, profileId);
  } catch (err) {
    if (err instanceof SiteNotFoundError) return notFound();
    return unexpected(site, err);
  }

  const manifest: KvManifest = {
    siteId: site.id,
    versionId: site.currentVersionId,
    // Drafts and kept pages are both `live`; the clock lives in Postgres and
    // never in the manifest.
    status: "live",
    // From the row, never a hardcoded "auto" — an EU page must not come back
    // pointing at the wrong bucket.
    region: site.region,
    // The page is owned as of the transaction above.
    ownerId: profileId,
    updatedAt: Date.now(),
  };

  const written = await writeManifest(site.slug, manifest);
  if (!written.ok) {
    // NOT SWALLOWED. Postgres has committed: the page is owned, permanent (or
    // on a fresh clock at the cap) and marked `live`, but the edge still says
    // gone. Saying "kept!" here would be a lie the user only discovers by
    // clicking their own link. The row is internally consistent and Postgres is
    // the authority, so the restore is replayable — by E07's divergence audit,
    // or by any later write on the page (E06's replace/rename) going through
    // `writeManifest` again.
    console.error(
      `[kept] anon keep: RESTORE INCOMPLETE — site ${site.id} (slug "${site.slug}") is kept and marked live in Postgres, but the manifest write failed at the "${written.step}" step: ${written.error}. The page is NOT serving; the row disagrees. E07 DIVERGENCE AUDIT: Postgres is the authority, never an R2 list (contract §7.5).`,
    );
    return fail(500, {
      error: "internal_error",
      message:
        "This page is now on your account, but kept could not bring it back online. Nothing was lost — the page is recorded as live and will be restored.",
    });
  }
  // `written.purge.ok === false` is NOT a failure (edge-purge contract §3):
  // both stores agree, the edge is merely stale until the logged retry lands,
  // and `writeManifest` has already logged it.

  return success(result, site.slug, true);
}
