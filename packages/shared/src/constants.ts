// @kept/shared — cross-app constants. Single source of truth; never duplicate these.
//
// Deferred enum delta: `PLANS` still carries `supporter` (see `./enums`). It is a
// pre-pivot value, but it drives the Drizzle `plan` pgEnum in
// apps/web/lib/db/schema.ts and the committed migration — dropping a Postgres enum
// value is a migration, not a rename. Owned by E05, which owns `profiles`/billing.
// `SITE_STATUSES` is already clean — E04's migration rewrote the `site_status` pg
// enum; `plan` is the last pre-pivot type left.

/** Maximum size of a single published page's HTML, in bytes (5 MB). */
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;

/** Pages an account may keep forever, free. */
export const KEPT_PAGE_LIMIT = 3 as const;

/** Days a draft stays online before it expires unless it is kept. */
export const DRAFT_TTL_DAYS = 7 as const;

/** Days after a draft expires that it stays recoverable before deletion. */
export const DRAFT_GRACE_DAYS = 30 as const;
