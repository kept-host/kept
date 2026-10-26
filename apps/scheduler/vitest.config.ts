// @kept/scheduler — test runner config. Runs on the real Workers runtime
// (workerd, via Miniflare) with the `wrangler.toml --env dev` vars, so the
// suite checks the deployed `CRON_JOBS` list, not a copy of it. Offline: the
// tests never call the scheduled handler, so no request leaves the machine.

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
