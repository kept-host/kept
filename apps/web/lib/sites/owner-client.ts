/**
 * The browser's client for the owner-scoped management routes — E06 task 005.
 * Task 006 extends it with replace and delete.
 *
 * Same posture as `lib/publish/client.ts`: this module knows the endpoint's URL
 * and nothing else. It serializes the request the route already accepts, parses
 * the response with the SAME `@kept/shared` schemas the route answers with, and
 * hands back a discriminated result. No retries, no state, no DOM.
 *
 * ⚠️ BROWSER-SAFE ON PURPOSE. Nothing here may import `lib/sites/rename.ts`,
 * `lib/db/*` or `lib/storage/*` — those reach Postgres, R2 and KV. The one
 * validation rule it shares with the server comes from `lib/publish/slug.ts`,
 * which is pure by design precisely so this file can call it.
 */
import {
  MANIFEST_KV_CACHE_TTL_SECONDS,
  publishErrorSchema,
  renameResultSchema,
  type PublishError,
  type RenameRequest,
  type RenameResult,
} from "@kept/shared";

export { checkChosenSlug, type SlugRefusal, type SlugRefusalReason } from "../publish/slug";

/** A rename attempt: the moved page, or an error from the closed enum. */
export type RenameOutcome =
  | { ok: true; page: RenameResult }
  | { ok: false; error: PublishError };

const SECONDS_PER_MINUTE = 60;

/**
 * How long the OLD address can still answer, in whole minutes.
 *
 * Derived, never typed as a literal: it is the same
 * `2 × MANIFEST_KV_CACHE_TTL_SECONDS + 5 s` that `lib/storage/manifest.ts`
 * sizes its second purge from. Past that point the re-purge has run and the
 * edge cannot be holding a response built from the pre-rename manifest.
 */
const OLD_URL_MINUTES = Math.round(
  (2 * MANIFEST_KV_CACHE_TTL_SECONDS + 5) / SECONDS_PER_MINUTE,
);

/**
 * What to tell someone who just renamed a page.
 *
 * ⚠️ THE OLD URL DOES NOT 404 IMMEDIATELY AND THIS SENTENCE MUST NOT SAY IT
 * DOES. The Worker reads KV with `cacheTtl: MANIFEST_KV_CACHE_TTL_SECONDS` (60,
 * already Cloudflare's floor) and `purge_cache` does not reach that layer, so
 * "live at the new URL, old URL 404s instantly" is not achievable and never was
 * — epic decision D2 says so in as many words.
 *
 * MEASURED, not calculated — dev stack, 2026-08-22, with the repo's own
 * `writeManifest`/`removeManifest` against the deployed Worker:
 *
 *   · a page warmed for 90 s (Cache API `HIT`, `age` climbing to 86) stopped
 *     serving **4 seconds** after `removeManifest` returned;
 *   · a page one second old stopped serving in **1 second**;
 *   · neither run reproduced the re-cached-from-a-stale-KV-read tail that
 *     `manifest.ts` documents from 2026-08-05, because a Cache API HIT never
 *     re-reads KV — that tail needs a cache miss landing inside the 60 s
 *     window, and the delayed second purge is what ends it.
 *
 * So the truthful shape of the sentence is: it is over in seconds in practice,
 * bounded by `OLD_URL_MINUTES` in the worst case, and **nobody is dropped in
 * the meantime** — both slugs resolve to the same page while the old one lives,
 * which is exactly why the rename writes the new manifest before removing the
 * old one. Do not "tighten" this to an instant cutover.
 */
export function renameNotice(page: RenameResult): string {
  if (page.previousSlug === page.slug) {
    return "That is already this page's address — nothing changed.";
  }
  return `Your page is live at ${page.liveUrl}. The old address keeps working for up to about ${OLD_URL_MINUTES} minutes and then stops, so nobody following an old link is dropped in the meantime.`;
}

/** Turn a non-200 into a `PublishError`, falling back for non-handler responses. */
async function readError(response: Response): Promise<PublishError> {
  const parsed = publishErrorSchema.safeParse(await response.json().catch(() => null));
  if (parsed.success) return parsed.data;
  return {
    error: "internal_error",
    message: `kept couldn't rename the page (HTTP ${response.status}). Nothing changed — try again.`,
  };
}

/**
 * `PATCH /api/sites/:id/slug`.
 *
 * ⚠️ THE CALLER MUST NAVIGATE. `/site/[slug]` is keyed by slug, so on success
 * the client has to `router.replace` onto `page.slug` — otherwise the user's
 * next navigation 404s on their own page. That is why the response carries it.
 *
 * The slug is checked locally first (`checkChosenSlug`) only to save a round
 * trip on an obviously-wrong name; the server runs the identical function and
 * is the only authority — and availability is not checked here AT ALL, because
 * `sites_slug_key` is the only thing that can answer it. A "taken" answer
 * arrives as a 409 from this call, never from a pre-flight probe.
 *
 * Never throws, including on abort.
 */
export async function renamePage(
  siteId: string,
  slug: string,
  signal?: AbortSignal,
): Promise<RenameOutcome> {
  const body: RenameRequest = { slug };
  let response: Response;
  try {
    response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/slug`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    return {
      ok: false,
      error: {
        error: "internal_error",
        message:
          "kept couldn't be reached. Nothing changed — check your connection and try again.",
      },
    };
  }

  if (response.status !== 200) return { ok: false, error: await readError(response) };

  const parsed = renameResultSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        error: "internal_error",
        message: "kept answered with something this page could not read. Reload to see where your page ended up.",
      },
    };
  }
  return { ok: true, page: parsed.data };
}
