/**
 * The anonymous bearer token, resolved to a page — E04 task 006.
 *
 * THIS IS THE ONLY PLACE A TOKEN IS TURNED INTO A SITE. The replace, delete and
 * reminder routes call it, and tasks 008 (`/p/[anonToken]`) and 009
 * (`/keep/[anonToken]`) re-use it unchanged. A second resolver is a second place
 * to get the 404 shape, the hashing or the status guard subtly different.
 *
 * THE TOKEN IS A BEARER CAPABILITY. One string grants replace and delete on
 * somebody's page with no other authentication, so it is handled like one:
 *
 * - It arrives as a **path segment**, never a query string. Query strings land
 *   in access logs, proxy logs and `Referer` headers by default; a path segment
 *   lands in fewer of them. This is the least-bad option rather than a good one,
 *   and it is forced: the token has to be pasteable into a browser, which rules
 *   out a header. Nothing here ever issues a redirect carrying the token, since
 *   a redirect target leaks through `Referer` to whatever it lands on.
 * - It is **never logged** — not in an error path, not in a debug line. The
 *   failure logs below name the slug and the site id, which are enough to
 *   diagnose anything and grant nothing.
 * - It is **never echoed into a response body**, and never persisted raw. Only
 *   `hashToken(token)` leaves this module.
 *
 * WHY THERE IS NO CONSTANT-TIME COMPARISON, AND WHY ONE MUST NOT BE ADDED. The
 * database stores `sites.anon_token_hash` — a SHA-256 digest — and there is no
 * raw-token column to compare against, so no secret is ever compared with `===`.
 * The lookup is an index equality on a digest; the only thing a timing side
 * channel could reveal is how many leading bytes of a DIGEST an attacker
 * matched, and turning that into a token means inverting SHA-256 over a 32-byte
 * CSPRNG input. `crypto.timingSafeEqual` here would protect nothing and would
 * imply the raw token is stored, which is precisely the design that was
 * rejected.
 */
import { hashToken } from "@kept/shared";

import { findSiteByAnonTokenHash, type AnonSite } from "../db/queries/publish";
import { fail, type PublishFailure } from "./pipeline";

export type { AnonSite };

/**
 * ONE 404 FOR EVERYTHING — unknown token, malformed token, archived page,
 * expired-past-grace page, moderation takedown. A distinguishable response is an
 * oracle: it turns a token guess into a probe for "does this page exist", and it
 * tells a stranger holding a stale link more about somebody else's page than
 * they are entitled to know.
 *
 * `invalid_request` because `PUBLISH_ERROR_CODES` is a CLOSED enum shared with
 * `POST /api/publish` (E08 branches on it) and a new code cannot be invented
 * here. The status — 404 — is what distinguishes it from a malformed body.
 */
export function notFound(): PublishFailure {
  return fail(404, {
    error: "invalid_request",
    message:
      "No page matches this link. It may have been deleted, or the link may be wrong — check the address you were given when the page was published.",
  });
}

/**
 * Resolve a raw token to the page it manages, or `null`.
 *
 * `null` covers every reason uniformly. Callers must answer it with
 * `notFound()`, never with a reason.
 *
 * A page is manageable only while it is `live`. `archived` (deleted by its
 * publisher), `expired`, `removed`, `quarantined` and `under_review` are all
 * unmanageable — replacing the bytes behind a moderated page would be an
 * obvious abuse path, and resurrecting an archived one is not a flow that
 * exists. Delete is the exception and handles it itself: a second delete has to
 * succeed, so it resolves with `requireLive: false`.
 */
export async function resolveAnonToken(
  token: string,
  options: { requireLive?: boolean } = {},
): Promise<AnonSite | null> {
  const { requireLive = true } = options;

  // Cheap structural reject before touching Postgres: the token is 32 random
  // bytes in unpadded base64url, so anything outside that alphabet — a slug, a
  // path traversal attempt, an empty segment — cannot be one.
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;

  const site = await findSiteByAnonTokenHash(await hashToken(token));
  if (!site) return null;
  if (requireLive && site.status !== "live") return null;

  return site;
}
