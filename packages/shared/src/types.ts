// @kept/shared — shared TS types. Schema-inferred types (Site, Profile,
// PublishPayload, KvManifest) are re-exported from their source modules via
// index.ts. This module holds types that aren't tied to a single zod schema.

import type { ManifestStatus } from "./kv-manifest";

/**
 * R2 object key for a published file.
 * `sites/{siteId}/{versionId}/{path}` — `path` defaults to `index.html`.
 */
export type R2ObjectKey = `sites/${string}/${string}/${string}`;

/** Outcome of branching on a manifest status in the serving layer (E0). */
export interface ServeDecision {
  status: ManifestStatus;
  /** Whether page content should be served for this status. */
  servesContent: boolean;
}
