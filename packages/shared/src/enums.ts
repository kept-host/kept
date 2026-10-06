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
 * migration, not a rename. The same rule binds every tuple in this file.
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

/**
 * Account plan tier. `premium` is the paid Pro tier — a valid value from E05
 * onward, given meaning by E11. Same migration rule as `SITE_STATUSES` above.
 */
export const PLANS = ["free", "premium"] as const;

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

// The three tuples below are control-plane vocabulary (E06) the Worker never
// reads — but this module IS in the Worker's bundle, because the KV manifest
// schema uses `regionEnum`. `/*#__PURE__*/` is what lets the bundler drop their
// zod enums there; without it each `z.enum(...)` would run on every Worker cold
// start. (E06 task 001 proved the Worker bundle byte-identical with them in.)

/**
 * How a page got its current name (D3).
 * - `generated` — minted at publish; free, and never counted against a quota.
 * - `chosen`    — set by its owner through rename, which only a kept page may
 *                 do. Counts against `limitsFor(plan).chosenNames` until the
 *                 page is `archived` / `removed`, so a demoted page keeps
 *                 counting.
 */
export const NAME_KINDS = ["generated", "chosen"] as const;

export const nameKindEnum = /*#__PURE__*/ z.enum(NAME_KINDS);
export type NameKind = (typeof NAME_KINDS)[number];

/**
 * Who wrote a page's title (D11, `sites.title_source`).
 * - `html`  — the page's own `<title>`, refreshed by every write that carries
 *             new bytes.
 * - `owner` — set by its owner on the page-detail screen; no replace or restore
 *             overwrites it. Clearing it hands the title back to `html`.
 */
export const TITLE_SOURCES = ["html", "owner"] as const;

export const titleSourceEnum = /*#__PURE__*/ z.enum(TITLE_SOURCES);
export type TitleSource = (typeof TITLE_SOURCES)[number];

/**
 * Which door a version was published through (`site_versions.published_via`,
 * PRD §5.9) — shown in the version list.
 * - `web`    — the anonymous browser path: the landing's drop, and an
 *              anonymous replace sent same-origin.
 * - `api`    — keyless `POST /api/publish` / `/api/anon/*` without a browser.
 * - `studio` — a signed-in publish or replace (`POST /api/sites`, E06).
 * - `mcp`    — the MCP agent path (E08); valid now so E08 needs no enum migration.
 */
export const PUBLISH_CHANNELS = ["web", "api", "studio", "mcp"] as const;

export const publishChannelEnum = /*#__PURE__*/ z.enum(PUBLISH_CHANNELS);
export type PublishChannel = (typeof PUBLISH_CHANNELS)[number];

/**
 * Why a chosen name is held for its last owner (D4, `NAME_HOLD_DAYS`).
 * - `deleted`         — the owner deleted (archived) the page.
 * - `renamed`         — the owner renamed the page away from it.
 * - `purged`          — E07's purge removed the page (`releaseName`).
 * - `account_deleted` — the account was deleted; the hold has no user.
 */
export const NAME_HOLD_REASONS = ["deleted", "renamed", "purged", "account_deleted"] as const;

export const nameHoldReasonEnum = /*#__PURE__*/ z.enum(NAME_HOLD_REASONS);
export type NameHoldReason = (typeof NAME_HOLD_REASONS)[number];
