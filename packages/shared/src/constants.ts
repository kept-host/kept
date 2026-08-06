// @kept/shared — cross-app constants. Single source of truth; never duplicate these.

/** Maximum size of a single published page's HTML, in bytes (5 MB). */
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;

/** Pages an account may keep forever, free. */
export const KEPT_PAGE_LIMIT = 3 as const;

/** Days a draft stays online before it expires unless it is kept. */
export const DRAFT_TTL_DAYS = 7 as const;

/** Days after a draft expires that it stays recoverable before deletion. */
export const DRAFT_GRACE_DAYS = 30 as const;

/**
 * `cacheTtl` the Worker asks for on its KV manifest read, in seconds. **60 is
 * Cloudflare's minimum accepted value** and cannot be lowered.
 *
 * Shared rather than edge-local because BOTH apps depend on the number and for
 * opposite reasons: `apps/edge` passes it to `KEPT_KV.get`, and `apps/web` sizes
 * its post-purge re-purge delay from it (`lib/storage/manifest.ts`). A KV write
 * does not invalidate a `cacheTtl` entry and `purge_cache` does not reach that
 * layer, so this is the window in which the edge can still answer with the
 * PRE-CHANGE manifest — the control plane cannot know when a purge has actually
 * taken effect without it.
 */
export const MANIFEST_KV_CACHE_TTL_SECONDS = 60 as const;
