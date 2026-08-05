// @kept/shared — enums as `as const` value tuples + zod enums so values and types
// stay in sync. Drizzle pgEnums (task 006) are driven from these to prevent drift.

import { z } from "zod";

/**
 * Lifecycle status of a site.
 * - `live`         — serving content.
 * - `under_review` — held pending moderation (E07).
 * - `quarantined`  — flagged/suspended, no content served (E07).
 * - `expired`      — draft clock elapsed; traffic stopped (clock set by E04,
 *                    enforced by E07's expiry jobs).
 * - `removed`      — taken down by owner/moderation.
 * - `archived`     — archive-don't-delete cold state (E07). Never written to KV.
 *
 * There is deliberately **no `draft` status**. Draft-ness is derived —
 * `sites.expires_at != null` — so a draft and a kept page share the `live`
 * status and the same serving path. See apps/web/lib/db/schema.ts.
 *
 * ⚠️ This tuple drives the Drizzle `pgEnum` in apps/web/lib/db/schema.ts, so a
 * value may only be added or removed here together with a generated migration
 * that rewrites the `site_status` Postgres type — dropping an enum value is a
 * migration, not a rename. E04 did exactly that to retire the last pre-pivot
 * status. `supporter` in `PLANS` below is the remaining pre-pivot value and is
 * E05's to remove, with its own migration — do not delete it here.
 */
export const SITE_STATUSES = [
  "live",
  "under_review",
  "quarantined",
  "expired",
  "removed",
  "archived",
] as const;

export const siteStatusEnum = z.enum(SITE_STATUSES);
export type SiteStatus = (typeof SITE_STATUSES)[number];

/** Account plan tier. */
export const PLANS = ["free", "supporter", "premium"] as const;

export const planEnum = z.enum(PLANS);
export type Plan = (typeof PLANS)[number];

/**
 * Data residency region for a site's files.
 * - `auto` — default bucket (v1).
 * - `eu`   — EU-jurisdiction bucket (activates in E11, no migration needed).
 */
export const REGIONS = ["auto", "eu"] as const;

export const regionEnum = z.enum(REGIONS);
export type Region = (typeof REGIONS)[number];
