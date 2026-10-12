/**
 * Cloudflare's published Turnstile TEST keys (developers.cloudflare.com →
 * Turnstile → Testing). Public by design: they talk to the real siteverify
 * endpoint, which answers with a fixed verdict and `result_with_testing_key`.
 *
 * Test-only: nothing in the app imports it, and its name keeps it outside the
 * unit-test glob. E2E specs and the local/CI `.env.example` defaults use the
 * same values.
 */
export const TURNSTILE_TEST_KEYS = {
  /** Visible widget that always passes. */
  siteKeyPass: "1x00000000000000000000AA",
  /** Visible widget that always blocks. */
  siteKeyBlock: "2x00000000000000000000AB",
  /** Siteverify accepts every token. */
  secretPass: "1x0000000000000000000000000000000AA",
  /** Siteverify rejects every token (`invalid-input-response`). */
  secretFail: "2x0000000000000000000000000000000AA",
  /** What the test site keys hand the browser. */
  dummyToken: "XXXX.DUMMY.TOKEN.XXXX",
} as const;

/** Point this process's `turnstileConfig()` at the always-pass or always-fail secret. */
export function setTurnstileTestKeys(verdict: "pass" | "fail"): void {
  process.env.TURNSTILE_SECRET_KEY =
    verdict === "pass" ? TURNSTILE_TEST_KEYS.secretPass : TURNSTILE_TEST_KEYS.secretFail;
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY =
    verdict === "pass" ? TURNSTILE_TEST_KEYS.siteKeyPass : TURNSTILE_TEST_KEYS.siteKeyBlock;
}
