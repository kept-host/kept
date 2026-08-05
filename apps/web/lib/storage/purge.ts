/**
 * Cloudflare cache purge — `docs/edge-purge-contract.md` §3.
 *
 *   POST https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache
 *   {"files": ["https://foo.kept.host/", "https://foo.kept.host/index.html"]}
 *
 * PURGE BY URL ONLY. Cloudflare's cache-tag purge (`{"tags": [...]}`) requires
 * an Enterprise zone plan and is NOT available on this account (§2). Do not add
 * a tags branch here and do not emit `Cache-Tag` headers at the edge expecting
 * one to become possible later — it forces the Worker's cache key to stay the
 * bare public request URL, which is why `apps/edge/src/cache.ts` mixes nothing
 * manifest-derived into it.
 *
 * THIS CLIENT TAKES URLs, NOT A SLUG. Building the two URL forms (`/` and
 * `/index.html`) belongs to the manifest write helper (task 004), so that the
 * §5 rule — "if the KV manifest for a slug is written, purge that slug" — has
 * exactly one owner. A purge client that knew about slugs would invite a second
 * caller that purges without writing a pointer, which is the §7.3 failure.
 *
 * FAILURE IS A VALUE, NEVER A THROW (§3 "Failure handling", §5, §6). By the time
 * a purge runs, Postgres, R2 and KV have already succeeded: the page is correct
 * and only the edge is stale. A failed purge is logged, alerted and retried by
 * the caller — never rolled back, never surfaced as a publish failure. Nothing
 * in this module throws, including a missing `CLOUDFLARE_ZONE_ID`, which comes
 * back as a plainly-named failure rather than a 500 on someone's publish.
 *
 * The token is the existing `CLOUDFLARE_API_TOKEN` — E02 task 004 provisioned
 * zone-scoped `Cache Purge` on both tracks. No new credential.
 */
import { CF_API, purgeConfig } from "./env";

/** Cloudflare's documented per-request cap on `files` (§3). */
export const PURGE_MAX_URLS_PER_REQUEST = 30;

export type PurgeResult = { ok: true } | { ok: false; error: string };

interface CloudflarePurgeResponse {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
}

/** Cloudflare answers 200 with `success: false` for some rejections. */
async function readFailure(res: Response): Promise<string | null> {
  let body: CloudflarePurgeResponse | null = null;
  try {
    body = (await res.json()) as CloudflarePurgeResponse;
  } catch {
    body = null;
  }

  const detail = body?.errors
    ?.map((e) => `${e.code ?? "?"}: ${e.message ?? "unknown"}`)
    .join(", ");

  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? ' — token likely missing zone-scoped "Cache Purge"'
        : "";
    return `HTTP ${res.status}${detail ? ` (${detail})` : ""}${hint}`;
  }
  if (body?.success === false) {
    return `Cloudflare reported failure${detail ? ` (${detail})` : ""}`;
  }
  return null;
}

/**
 * Purge the exact URLs given. `purge_cache` matches the URL string literally,
 * so every form the Worker can serve a page under must be listed (§4).
 *
 * Batched at the API's 30-URL limit; every batch must succeed for the result to
 * be `ok`. v1 is single-HTML-file, so a real call carries two URLs.
 */
export async function purgeUrls(urls: readonly string[]): Promise<PurgeResult> {
  // A no-op purge is not a failure — there is nothing at the edge to invalidate.
  if (urls.length === 0) return { ok: true };

  try {
    const { zoneId, apiToken } = purgeConfig();
    const endpoint = `${CF_API}/zones/${zoneId}/purge_cache`;

    for (let i = 0; i < urls.length; i += PURGE_MAX_URLS_PER_REQUEST) {
      const files = urls.slice(i, i + PURGE_MAX_URLS_PER_REQUEST);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ files }),
      });
      const failure = await readFailure(res);
      if (failure) return { ok: false, error: `purge ${files.length} URL(s) → ${failure}` };
    }

    return { ok: true };
  } catch (err) {
    // Includes an unset/malformed CLOUDFLARE_ZONE_ID and any network error.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
