// @kept/shared — cross-app constants. Single source of truth; never duplicate these.

/** Cost in EUR to fund one published-page slot (sponsor-a-slot economics, E4). */
export const SLOT_COST_EUR = 0.01 as const;

/** Maximum size of a single published page's HTML, in bytes (5 MB). */
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;

/** Pages a free-plan account may keep concurrently. */
export const FREE_PAGE_LIMIT = 3 as const;

/**
 * Supporter-plan page cap. Placeholder (~15) pending finalized tier sizing (E4).
 * Lives here so raising the cap is a one-line change consumed by both apps.
 */
export const SUPPORTER_PAGE_LIMIT = 15 as const;

/** Days an anonymous page serves before it `expired`s (claim window). */
export const ANON_HOLD_DAYS = 7 as const;

/** Days after expiry an unclaimed page is recoverable before deletion (grace). */
export const ANON_GRACE_DAYS = 30 as const;
