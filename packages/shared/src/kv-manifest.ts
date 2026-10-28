// @kept/shared — the KV manifest contract.
//
// The control plane (apps/web) writes one manifest per published slug into KV;
// apps/edge reads it to serve a page. This is the *exact* shape from E00's
// "KV manifest contract", and E03 is the epic that reads it. Keyed by slug in
// KV; the manifest itself is keyed on `siteId` (not slug), so renaming a slug is
// a KV-only change with no file move.
//
// R2 layout: `sites/{siteId}/{versionId}/{path}` — one object per file of the
// version's set (E08 D1), in the bucket selected by `region`.

import { z } from "zod";

import { badgeDataSchema } from "./badge";
import { regionEnum } from "./enums";

/**
 * Statuses the serving layer can encounter in a manifest. A strict subset of
 * `SiteStatus`, and the Worker's total switch is driven off it (E03 task 002):
 * adding a value here is a typecheck failure at the status branch, never a
 * silent fall-through to "serve the content".
 *
 * Two `SiteStatus` values are deliberately absent. `archived` is the
 * archive-don't-delete cold state — never written to KV, nothing to serve, so it
 * is not a serving status. The retired pre-pivot funding-degradation status is
 * gone from the serving contract entirely: no value here, no system page, no
 * code path. Its identically-named `SITE_STATUSES` twin is a *different symbol*
 * baked into a `pgEnum`; see the note in ./enums.
 */
export const MANIFEST_STATUSES = [
  "live",
  "under_review",
  "quarantined",
  "expired",
  "removed",
] as const;

export const manifestStatusEnum = z.enum(MANIFEST_STATUSES);
export type ManifestStatus = (typeof MANIFEST_STATUSES)[number];

/** The KV manifest value. */
export const kvManifestSchema = z.object({
  siteId: z.string(),
  /** Current version → R2 prefix. */
  versionId: z.string(),
  status: manifestStatusEnum,
  /** Which R2 bucket to read from (v1: always `auto`; `eu` activates in E11). */
  region: regionEnum,
  ownerId: z.string().nullable(),
  /** Epoch milliseconds of the last manifest write. */
  updatedAt: z.number(),
  /**
   * SPA fallback (E08 D12): an extensionless last path segment serves the root
   * `index.html`. Writers omit it when false, so a single-file manifest is
   * byte-identical to `dev-v0.8.0`.
   */
  spa: z.boolean().optional(),
  /**
   * The set has a root `404.html` (E08 D13), served with status 404 on a miss.
   * Writers omit it when false, so a single-file manifest is byte-identical to
   * `dev-v0.8.0`.
   */
  has404: z.boolean().optional(),
  /**
   * What the page's badge shows (E10 D3). Absent on manifests written before
   * E10 — the Worker serves those without a badge until the backfill rewrites
   * them.
   */
  badge: badgeDataSchema.optional(),
});

export type KvManifest = z.infer<typeof kvManifestSchema>;

/**
 * A retired handle's KV value (E10 D10, Q1): no page, only where it went. The
 * Worker answers any request to the old host with a 301 to the same path on
 * `{redirectTo}.{base}` before any R2 read. A separate shape rather than a
 * field on the page manifest, whose ids and status a redirect does not have —
 * and `MANIFEST_STATUSES` stays closed.
 */
export const kvRedirectManifestSchema = z.object({
  /** The owner's CURRENT handle — every old handle points straight at it (Q2). */
  redirectTo: z.string(),
  /** Epoch milliseconds of the last write. */
  updatedAt: z.number(),
});

export type KvRedirectManifest = z.infer<typeof kvRedirectManifestSchema>;

/**
 * Anything the control plane writes under a slug key: a page or a redirect.
 * The redirect member is tried second, so a page manifest always parses as one.
 */
export const kvEntrySchema = z.union([kvManifestSchema, kvRedirectManifestSchema]);

export type KvEntry = z.infer<typeof kvEntrySchema>;

export function isRedirectManifest(entry: KvEntry): entry is KvRedirectManifest {
  return "redirectTo" in entry;
}
