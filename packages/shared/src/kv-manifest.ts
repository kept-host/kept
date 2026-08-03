// @kept/shared — the KV manifest contract.
//
// The control plane (apps/web) writes one manifest per published slug into KV;
// apps/edge reads it to serve a page. This is the *exact* shape from E00's
// "KV manifest contract", and E03 is the epic that reads it. Keyed by slug in
// KV; the manifest itself is keyed on `siteId` (not slug), so renaming a slug is
// a KV-only change with no file move.
//
// R2 layout: `sites/{siteId}/{versionId}/index.html` (+ future paths), in the
// bucket selected by `region`.

import { z } from "zod";

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
});

export type KvManifest = z.infer<typeof kvManifestSchema>;
