import { config } from "dotenv";
import type { APIRequestContext, Page } from "@playwright/test";

/**
 * The gate and the cleanup every spec that publishes for real shares.
 *
 * `POST /api/publish` writes Postgres, R2 and KV and then purges the edge
 * cache — there is nothing to stub, and nothing here does. That means a spec
 * driving the hero to `live` needs the dev credentials, which CI deliberately
 * does not have (`.github/workflows/ci.yml`: fork PRs run with no environment).
 * So those tests SKIP when the variables are absent, exactly as task 004/005's
 * live drills do, and the CI-side publish→serve canary with its own ephemeral
 * database branch is task 010's.
 *
 * Not a `*.spec.ts`, so Playwright never collects it as a test file.
 */
config({ path: ".env.local", quiet: true });

/** Everything `publishPage` reads before it can answer 201. */
const LIVE_VARS = [
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_AUTO",
  "KV_NAMESPACE_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "KEPT_BASE_DOMAIN",
  "NEXT_PUBLIC_APP_URL",
  "PUBLISHER_HASH_SALT",
] as const;

const missing = LIVE_VARS.filter((name) => !process.env[name]);

/**
 * `false` when a real publish can run, otherwise the reason to skip. Feed it
 * straight to `test.skip(...)`.
 */
export const SKIP_LIVE_PUBLISH: string | false =
  missing.length > 0
    ? `dev credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local`
    : false;

/**
 * The serving suffix the control plane mints links on: `kept-dev.xyz` on dev,
 * `kept.host` on prod. Read, never assumed — a spec that hardcodes `.kept.host`
 * fails on dev for entirely the wrong reason.
 */
export const servingDomain = (): string => process.env.KEPT_BASE_DOMAIN!;

/** A minimal, valid single-file document, marked so runs never dedup together. */
export const pageHtml = (marker: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marker}</title></head><body><h1>${marker}</h1></body></html>\n`;

/**
 * Collect the anon token of every draft this page publishes, so the test can
 * delete them again. Anything left behind is a real draft on the dev track for
 * seven days.
 */
export function trackDrafts(page: Page): Promise<string | null>[] {
  // Promises, not strings: the body is read asynchronously, and a teardown that
  // ran before the read resolved would silently leak the draft it was written
  // to remove.
  const tokens: Promise<string | null>[] = [];
  page.on("response", (response) => {
    if (!response.url().includes("/api/publish") || response.status() !== 201) return;
    tokens.push(
      response
        .json()
        .then((body: { anonToken?: unknown }) =>
          typeof body.anonToken === "string" ? body.anonToken : null,
        )
        .catch(() => null),
    );
  });
  return tokens;
}

/** Delete every tracked draft through the real anonymous manage API. */
export async function deleteDrafts(
  request: APIRequestContext,
  tokens: Promise<string | null>[],
): Promise<void> {
  for (const token of await Promise.all(tokens.splice(0))) {
    if (!token) continue;
    await request.delete(`/api/sites/${token}`).catch(() => {
      /* best effort: a failed teardown must not fail the assertion above it */
    });
  }
}
