// @kept/edge — the Cache API layer: lookup, header policy, store.
//
// Caching is the cost model, not an optimisation. A cache hit returns without
// touching KV or R2, which is the only reason the "one KV read + one R2 read"
// budget is affordable at scale. The lookup therefore sits BEFORE the KV read in
// `index.ts`, not after it.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CACHE KEY IS THE BARE REQUEST URL. NOTHING MAY BE MIXED INTO IT.
//
// Freshness comes from an explicit purge performed by the control plane on
// publish/replace/rename/demote/suspend/delete — not from an expiry race. On
// this Cloudflare plan the ONLY available purge mechanism is **purge-by-URL**:
// cache-tag purge is an ENTERPRISE-ONLY feature and is not available to this
// account, so tagging entries with `siteId`/`versionId` is not an option.
//
// Consequence: if anything manifest-derived (siteId, versionId, status) were
// folded into the cache key, or a `Vary` fanned the entry out across request
// headers, the write side's purge-by-URL call would miss the stored entry and a
// replaced page — or a quarantined one — would keep serving for a year. So the
// key is `request` itself, unmodified, and there is no custom key and no `Vary`.
//
// The write-side contract that depends on this lives in
// `docs/edge-purge-contract.md`. E03 documents it; E04/E06/E07 call it. This
// module performs no purge, no KV write and no R2 write.
// ─────────────────────────────────────────────────────────────────────────────

import type { SystemPage } from "./system-pages";

/**
 * `Cache-Control` for served page content.
 *
 * `s-maxage=31536000` (a year) because the edge entry is invalidated by purge,
 * not by expiry. `max-age=60` gives the visitor's own browser a one-minute
 * window: long enough to absorb a reload storm, short enough that a purge never
 * feels broken to the person who just replaced their page. Deliberately NO
 * `stale-while-revalidate` — `swr` exists to serve known-stale content, and a
 * cached entry cannot tell "old copy" from "taken down", so a moderation flip
 * would be served through the revalidation window.
 */
export const LIVE_CACHE_CONTROL = "public, max-age=60, s-maxage=31536000";

/** `Cache-Control` for responses that must never be stored anywhere. */
export const NO_STORE_CACHE_CONTROL = "no-store";

/**
 * `Cache-Control` per system page.
 *
 * - `notFound` — short edge caching (`s-maxage=60`) bounds the cost of bot
 *   traffic against random subdomains, where each miss costs a KV read and (per
 *   task 007) an R2 probe. It stays short because a slug that 404s today may be
 *   published tomorrow, and a year-long negative entry would outlive the purge
 *   the publish path fires.
 * - `suspended` / `expired` — `no-store`, and never written to the Cache API at
 *   all (see `storeResponse`). A cached quarantine is a moderation failure.
 */
const SYSTEM_PAGE_CACHE_CONTROL: Record<SystemPage, string> = {
  notFound: "public, max-age=0, s-maxage=60",
  suspended: NO_STORE_CACHE_CONTROL,
  expired: NO_STORE_CACHE_CONTROL,
};

/** Header policy for a branded system page. */
export function systemPageCacheControl(page: SystemPage): string {
  return SYSTEM_PAGE_CACHE_CONTROL[page];
}

/**
 * Only `GET` participates in the cache.
 *
 * `HEAD` is served correctly through the same pipeline but is neither looked up
 * nor stored — Cloudflare's Cache API is GET-only, and a `HEAD` entry would be a
 * bodyless response sitting under a key that `GET` requests would then hit.
 */
function isCacheableMethod(method: string): boolean {
  return method === "GET";
}

/**
 * Step 2 of the pipeline: the Cache API lookup.
 *
 * Returns the stored response on a hit — **zero KV, zero R2 operations** — and
 * `undefined` on a miss. Never throws: a failing cache is a slow request, not a
 * broken page.
 */
export async function lookupCached(
  request: Request,
): Promise<Response | undefined> {
  if (!isCacheableMethod(request.method)) return undefined;

  try {
    // `request` unmodified — see the cache-key note at the top of this file.
    return await caches.default.match(request);
  } catch {
    return undefined;
  }
}

/**
 * The one thing this module needs from an execution context.
 *
 * Structural, not `ExecutionContext`: Hono's `c.executionCtx` and the
 * workers-types global are two different declarations of the same runtime
 * object, and this module only ever calls `waitUntil` on it.
 */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Step 7: populate the cache, off the response path.
 *
 * The policy is read off the response's own `Cache-Control` rather than passed
 * in per branch, so a branch cannot say `no-store` and still be stored. Skipped
 * for: non-`GET`, `304` (a bodyless revalidation, never an origin entry), and
 * anything marked `no-store` (`suspended`/`expired`).
 *
 * The `put` runs under `ctx.waitUntil` so it never delays the response, and a
 * failure is swallowed — an unstored entry costs one extra origin read, which is
 * not worth turning somebody's page into an error.
 */
export function storeResponse(
  ctx: WaitUntil,
  request: Request,
  response: Response,
): void {
  if (!isCacheableMethod(request.method)) return;
  if (response.status === 304) return;

  const cacheControl = response.headers.get("Cache-Control");
  if (!cacheControl || cacheControl.includes("no-store")) return;

  try {
    ctx.waitUntil(
      caches.default.put(request, response.clone()).catch(() => {}),
    );
  } catch {
    // No `ExecutionContext`, or a body that cannot be teed. Serve anyway.
  }
}
