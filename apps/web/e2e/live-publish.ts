import { config } from "dotenv";
import {
  request as apiRequest,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";

import playwrightConfig from "../playwright.config";

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

/** Delete one draft through the real anonymous manage API. Best effort. */
export async function deleteDraft(
  request: APIRequestContext,
  token: string,
): Promise<void> {
  await request.delete(`/api/anon/${token}`).catch(() => {
    /* best effort: a failed teardown must not fail the assertion above it */
  });
}

/** Delete every tracked draft through the real anonymous manage API. */
export async function deleteDrafts(
  request: APIRequestContext,
  tokens: Promise<string | null>[],
): Promise<void> {
  for (const token of await Promise.all(tokens.splice(0))) {
    if (!token) continue;
    await deleteDraft(request, token);
  }
}

/**
 * The control plane under test, taken from Playwright's own `baseURL` so there
 * is ONE definition of it. Hooks that cannot take the test-scoped `request`
 * fixture (`beforeAll` / `afterAll`) build their own context against this.
 */
export const controlPlaneUrl: string = (() => {
  const baseURL = playwrightConfig.use?.baseURL;
  if (!baseURL) throw new Error("playwright.config.ts must define use.baseURL");
  return baseURL;
})();

/** An API context aimed at the control plane, for `beforeAll`/`afterAll`. */
export function newApiContext(): Promise<APIRequestContext> {
  return apiRequest.newContext({ baseURL: controlPlaneUrl });
}

/**
 * The bare `POST /api/publish` the PRD promises an agent: a `text/html` body and
 * nothing else — no cookie, no auth header, no Turnstile token. Returns the raw
 * response so a spec can assert the status, the headers AND the body; only the
 * caller knows which of those it is testing.
 *
 * `headers` exists for the ONE case that needs it: dedup is keyed on a salted
 * hash of IP + user agent, so a second, distinct publisher identity is a second
 * `user-agent` from the same machine.
 */
export function publishViaApi(
  request: APIRequestContext,
  html: string,
  headers: Record<string, string> = {},
): Promise<APIResponse> {
  return request.post("/api/publish", {
    headers: { "content-type": "text/html", ...headers },
    data: html,
  });
}

/** What one GET of a served page tells us. */
export interface EdgeProbe {
  status: number;
  cacheControl: string;
  contentType: string;
  body: string;
}

/**
 * One GET of a hosted page, straight off the deployed Worker.
 *
 * NO QUERY STRING, EVER. The Worker keys its cache on the whole URL, so a
 * cache-busting parameter would quietly defeat the purge these probes exist to
 * observe — the opposite of what `smoke-release.ts` needs, where a fresh URL is
 * what forces the pipeline. Plain `fetch`, not an `APIRequestContext`, so no
 * Playwright-side connection reuse or cookie jar is in the picture.
 */
export async function probeEdge(url: string): Promise<EdgeProbe> {
  const res = await fetch(url, { redirect: "manual" });
  return {
    status: res.status,
    cacheControl: res.headers.get("cache-control") ?? "",
    contentType: res.headers.get("content-type") ?? "",
    body: await res.text(),
  };
}
