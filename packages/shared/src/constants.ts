// @kept/shared — cross-app constants. Single source of truth; never duplicate these.

/** Maximum size of a single published page's HTML, in bytes (5 MB). */
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;

/**
 * Longest a slug may be — the DNS limit on a single hostname label, since a slug
 * becomes the first label of `{slug}.kept.host`. Named rather than inlined
 * because E06's rename shows the rule to a human in an inline validation
 * message, and a message that disagrees with `slugSchema` is worse than none.
 */
export const SLUG_MAX_LENGTH = 63 as const;

/** Pages an account may keep forever, free. */
export const KEPT_PAGE_LIMIT = 3 as const;

/** Days a draft stays online before it expires unless it is kept. */
export const DRAFT_TTL_DAYS = 7 as const;

/** Days after a draft expires that it stays recoverable before deletion. */
export const DRAFT_GRACE_DAYS = 30 as const;

/**
 * Longest a page title may be, in characters, after extraction and sanitising
 * (D11). The same cap binds an owner-set title.
 */
export const PAGE_TITLE_MAX_LENGTH = 80 as const;

/**
 * Days of per-page visits the studio keeps and charts — and the most a visits
 * sync may backfill (`?days=`), the retention Cloudflare's adaptive datasets
 * allow (D8).
 */
export const VISITS_HISTORY_DAYS = 30 as const;

/** The "recent" visits window: the home sort, the swap chooser and the card. */
export const VISITS_RECENT_DAYS = 7 as const;

/** Hours after the last successful visits sync before the studio calls it stale. */
export const VISITS_STALE_HOURS = 36 as const;

/**
 * `job_runs.job` key of the daily visits sync — written by the sync route,
 * read by every surface that shows "as of".
 */
export const VISITS_SYNC_JOB = "visits-sync" as const;

/**
 * Where abuse reports and moderation appeals go — the quarantined / under-review
 * banner's `mailto:`. The one address; no surface hardcodes another.
 */
export const ABUSE_CONTACT_EMAIL = "abuse@kept.host" as const;

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
