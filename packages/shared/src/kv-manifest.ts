// @kept/shared — the KV manifest contract.
//
// The control plane (apps/web) writes one manifest per published slug into KV;
// apps/edge reads it to serve a page. This is the *exact* shape from E0's
// "KV manifest contract". Keyed by slug in KV; the manifest itself is keyed on
// `siteId` (not slug), so renaming a slug is a KV-only change with no file move.
//
// R2 layout: `sites/{siteId}/{versionId}/index.html` (+ future paths), in the
// bucket selected by `region`.

import { z } from "zod";

import { regionEnum } from "./enums";

/**
 * Statuses the serving layer can encounter in a manifest. A subset of
 * `SiteStatus`: `archived` sites are never written to KV (nothing to serve).
 */
export const MANIFEST_STATUSES = [
  "live",
  "under_review",
  "quarantined",
  "resting",
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
  /** Which R2 bucket to read from (v1: always `auto`; `eu` activates in E8). */
  region: regionEnum,
  ownerId: z.string().nullable(),
  /** Epoch milliseconds of the last manifest write. */
  updatedAt: z.number(),
});

export type KvManifest = z.infer<typeof kvManifestSchema>;
