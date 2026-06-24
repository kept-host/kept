// @kept/edge — typed Worker environment.
//
// The serving plane reads exactly two stores and nothing else:
//   - KEPT_R2: R2 bucket with `sites/{siteId}/{versionId}/{path}` objects.
//   - KEPT_KV: KV namespace mapping `slug` → KV manifest (see @kept/shared).
// Binding names are a soft contract with task 005 (Cloudflare resources) and
// task 008 (`.env.example`); keep them in sync with `wrangler.toml`.

export interface Env {
  /** R2 bucket holding published page files. */
  KEPT_R2: R2Bucket;
  /** KV namespace holding the per-slug serving manifest. */
  KEPT_KV: KVNamespace;
}
