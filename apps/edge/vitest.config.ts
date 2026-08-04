// @kept/edge — test runner config.
//
// The suite runs on the REAL Workers runtime (workerd, via Miniflare) with REAL
// local KV and R2 implementations. There are no mock bindings anywhere in
// `test/` — that is both this repo's no-mocking rule and a practical necessity:
// R2's `onlyIf` precondition semantics, the Cache API, `ctx.waitUntil` and
// streamed bodies are exactly the things a hand-rolled fake gets wrong.
//
// Bindings come from `wrangler.toml --env dev`, so the binding names, the
// `KEPT_BASE_DOMAIN` / `KEPT_APEX_ORIGIN` vars and the compatibility date under
// test are the deployed ones and cannot drift from production config.
//
// OFFLINE + CREDENTIAL-FREE: Miniflare creates local KV/R2/cache simulacra under
// `.wrangler/state/` (gitignored). The namespace id and bucket name in
// `wrangler.toml` are never dialled, no Cloudflare token is read, and no network
// request leaves the machine. Any contributor can run `pnpm --filter @kept/edge
// test` on a clean checkout.
//
// Requires Node >= 22 (the repo's `engines.node`); workerd will not start on 20.

// Storage is isolated per test by the integration itself (v0.20+ — the old
// `poolOptions.workers.isolatedStorage` flag is gone because it is now always
// on), so a manifest seeded by one group can never leak into another and make a
// later assertion pass for the wrong reason.

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.toml",
        environment: "dev",
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
