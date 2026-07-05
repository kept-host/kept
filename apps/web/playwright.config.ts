import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright e2e config for @kept/web.
 *
 * The landing page runs an imperative rAF scroll-choreography engine that
 * throttles in headless/unfocused tabs — so these specs deliberately assert
 * structure, the drop→mint→live phase machine, and content, never scroll-driven
 * poses or reveal-on-scroll opacity (those are flaky headless).
 *
 * `webServer` lets CI (or a cold local run) boot the dev server itself; when a
 * server is already up on :3000 it is reused rather than restarted.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm --filter @kept/web dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
