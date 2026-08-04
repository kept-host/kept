// @kept/shared — enums as `as const` value tuples + zod enums so values and types
// stay in sync. Drizzle pgEnums (task 006) are driven from these to prevent drift.

import { z } from "zod";

/**
 * Lifecycle status of a site.
 * - `live`         — serving content.
 * - `under_review` — held pending moderation (E07).
 * - `quarantined`  — flagged/suspended, no content served (E07).
 * - `resting`      — RETIRED pre-pivot funding-degradation state. See the note
 *                    below; it is not a serving status.
 * - `expired`      — draft clock elapsed; traffic stopped (clock set by E04,
 *                    enforced by E07's expiry jobs).
 * - `removed`      — taken down by owner/moderation.
 * - `archived`     — archive-don't-delete cold state (E07). Never written to KV.
 *
 * ⚠️ `resting` here — and `supporter` in `PLANS` below — are pre-pivot values
 * that survive only because these tuples drive the Drizzle `pgEnum`s in
 * apps/web/lib/db/schema.ts and are baked into the committed migration
 * apps/web/drizzle/0000_nasty_moonstone.sql. Dropping a Postgres enum value is a
 * **migration, not a rename**, and it is owned by E04/E05. Do not delete them
 * here. The serving contract already excludes `resting`: it is absent from
 * `MANIFEST_STATUSES` (./kv-manifest), which is a plain tuple driving no pgEnum.
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
 * - `eu`   — EU-jurisdiction bucket (activates in E11, no migration needed).
 */
export const REGIONS = ["auto", "eu"] as const;

export const regionEnum = z.enum(REGIONS);
export type Region = (typeof REGIONS)[number];
