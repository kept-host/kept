// @kept/edge — typed Worker environment.
//
// The serving plane reads exactly two stores and nothing else:
//   - KEPT_R2: R2 bucket with `sites/{siteId}/{versionId}/{path}` objects.
//   - KEPT_KV: KV namespace mapping `slug` → KV manifest (see @kept/shared).
// Binding names are a soft contract with task 005 (Cloudflare resources) and
// task 008 (`.env.example`); keep them in sync with `wrangler.toml`.
//
// Everything else is plain per-environment config strings from `[env.*.vars]`.
// Dev serves `*.kept-dev.xyz` and prod `*.kept.host` from one code path: the
// difference arrives as a var, never as a `NODE_ENV`/branch fork (E02).

export interface Env {
  /** R2 bucket holding published page files. */
  KEPT_R2: R2Bucket;
  /** KV namespace holding the per-slug serving manifest. */
  KEPT_KV: KVNamespace;
  /** Serving suffix this environment answers for; no leading dot, no scheme. */
  KEPT_BASE_DOMAIN: string;
  /** Control-plane origin reserved labels 301 to; full origin, no trailing slash. */
  KEPT_APEX_ORIGIN: string;
}
