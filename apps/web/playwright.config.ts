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
 *
 * ── THE HARNESS RUNS ON https, AND THAT IS LOAD-BEARING (E05a D5) ───────────
 *
 * The session cookie is `__Host-kept.session_token` (see the block comment in
 * `lib/auth/index.ts`). A `__Host-` cookie is `Secure` by browser fiat, and
 * **a browser does not store a `Secure` cookie delivered over plain http**.
 * The prefix is unconditional on every track — local included — precisely so
 * the cookie shape you develop against is the one you ship; deriving a weaker
 * cookie from `NODE_ENV` or the protocol is forbidden.
 *
 * So `baseURL` and `webServer.url` are BOTH https, and `apps/web`'s own `dev`
 * script carries `--experimental-https` (one place owns that flag — do not
 * duplicate it into `webServer.command`).
 *
 * REVERTING EITHER URL TO http DOES NOT FAIL LOUDLY. The browser drops the
 * `Set-Cookie` silently: sign-in appears to succeed and the very next request
 * is signed out. The symptom looks like an auth bug and is not one. If session
 * specs start failing with "signed out" and nothing in the logs, check the
 * scheme here first.
 *
 * `ignoreHTTPSErrors` lives in `use` (not just in a per-project override) so it
 * covers page navigations AND the `request` fixture the API specs drive — the
 * certificate Next mints is locally-trusted for the OS, but Chromium under
 * Playwright uses its own store and refuses it otherwise.
 *
 * `reuseExistingServer` and a stale **http** server on :3000: measured, not
 * assumed. The readiness probe speaks https, so its TLS ClientHello reaches a
 * plain-http listener as garbage, the handshake fails, and the stale server is
 * NOT adopted — Playwright boots its own instead. The dangerous case (a stale
 * http server silently serving every spec) cannot happen. What CAN happen is
 * the reverse: a stray `next dev` already holding :3000 makes every spec time
 * out at 30s on navigation. Kill it first.
 *
 * `webServer.timeout` is 180s, not the old 120s. A warm boot that reuses
 * `apps/web/certificates/` is ~5s, but a COLD one downloads the mkcert binary
 * (~15s) and then runs `mkcert -install`, which prompts for a password on
 * macOS — nowhere near the compile-only budget the old value assumed.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL: "https://localhost:3000",
    ignoreHTTPSErrors: true,
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
    url: "https://localhost:3000",
    ignoreHTTPSErrors: true,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
