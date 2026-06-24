// @kept/shared — enums as `as const` value tuples + zod enums so values and types
// stay in sync. Drizzle pgEnums (task 006) are driven from these to prevent drift.

import { z } from "zod";

/**
 * Lifecycle status of a site.
 * - `live`         — serving content.
 * - `under_review` — held pending moderation (E5).
 * - `quarantined`  — flagged/suspended, no content served (E5).
 * - `resting`      — funding degradation, temporarily not served (E4).
 * - `expired`      — anonymous claim window elapsed; traffic stopped (E1/E5).
 * - `removed`      — taken down by owner/moderation.
 * - `archived`     — archive-don't-delete cold state (E4 degradation ladder).
 */
export const SITE_STATUSES = [
  "live",
  "under_review",
  "quarantined",
  "resting",
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
 * - `eu`   — EU-jurisdiction bucket (activates in E8, no migration needed).
 */
export const REGIONS = ["auto", "eu"] as const;

export const regionEnum = z.enum(REGIONS);
export type Region = (typeof REGIONS)[number];
