// @kept/edge — Hono Worker, serving data plane.
//
// Serves `{slug}.{KEPT_BASE_DOMAIN}` from R2 (files) + KV (manifest) ONLY. It may
// import @kept/shared but NEVER @kept/web — the one-way serve-path rule is
// enforced by the root ESLint `no-restricted-imports` guard.
//
// Pipeline (E03): host→slug → Cache API → KV lookup (+ the miss-only R2 pointer
// probe) → status branch → R2 fetch → headers + cache. Steps 1 (host→slug,
// reserved labels), 2 + 7 (the Cache API lookup and the `waitUntil` store), 3
// (the single KV read and the fallback), 4 (the status branch), 5–6 (path→key +
// the single R2 read) and the uniform security headers are all live.
//
// EVERY response in this file is built by `headers.ts`'s `buildResponse` — there
// is deliberately no bare `new Response(...)`, no `c.html()` and no
// `c.redirect()` here, so a branch added by a later epic cannot ship without the
// security header set.

import { Hono, type Context } from "hono";

import { renderBadge, type KvManifest, type RenderedBadge } from "@kept/shared";

import { injectBadge, injectsBadge } from "./badge";
import {
  FALLBACK_CACHE_CONTROL,
  LIVE_CACHE_CONTROL,
  NO_STORE_CACHE_CONTROL,
  SHORT_EDGE_CACHE_CONTROL,
  lookupCached,
  storeResponse,
  systemPageCacheControl,
  type WaitUntil,
} from "./cache";
import type { Env } from "./env";
import { buildResponse } from "./headers";
import { isSlugLabel, resolveHost } from "./host";
import { resolveManifest } from "./manifest";
import { fetchPage, fetchReadme } from "./r2";
import { renderSystemPage, type SystemPage } from "./system-pages";

const app = new Hono<{ Bindings: Env }>();

type AppContext = Context<{ Bindings: Env }>;

/** The only methods a static serving plane answers. `HEAD` is never cached. */
const SERVABLE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Render a branded system page with this environment's apex origin, so dev
 * renders dev links. `system-pages.ts` never reads `Env` itself — the caller
 * owns the bindings and passes the value down.
 *
 * `Cache-Control` comes from `cache.ts`'s policy table rather than from the
 * branch that chose the page, so no branch can invent its own caching. The
 * `kept-own` kind picks the strict CSP: this markup is ours, not a stranger's.
 */
function systemPage(c: AppContext, page: SystemPage): Response {
  const { body, status } = renderSystemPage(page, {
    apexOrigin: c.env.KEPT_APEX_ORIGIN,
  });
  return buildResponse(body, {
    status,
    kind: "kept-own",
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": systemPageCacheControl(page),
    },
  });
}

/**
 * Compile-time exhaustiveness guard for the status branch.
 *
 * The `never` parameter means adding a value to `MANIFEST_STATUSES` FAILS THE
 * TYPECHECK here rather than silently falling through to "serve the content".
 * At runtime this is reachable only if KV holds a manifest newer than the
 * deployed Worker, in which case the safe answer is the branded 404.
 */
function unhandledManifestStatus(_status: never): SystemPage {
  return "notFound";
}

/**
 * `Cache-Control` for page content: a response produced by D12's SPA rewrite is
 * edge-cached for a minute, not a year (Q-new-1). The write side purges the
 * URLs of the files it wrote; a deep route like `/dashboard/settings` is none of
 * them, so after a replace it may serve the old shell for at most 60 s.
 */
function rewrittenCacheControl(spaRewrite: boolean, pageCacheControl: string): string {
  return spaRewrite ? SHORT_EDGE_CACHE_CONTROL : pageCacheControl;
}

/** kept's own path space on every page host (E08 D7): nothing a user uploads. */
const KEPT_PATH_PREFIX = "/_kept/";

/** The README page of a kept page (E10 D6). */
const README_PATH = "/_kept/readme";

/**
 * A body for the visitor: the badge streamed in when the page has one and the
 * response is HTML (E10 D1), the R2 stream untouched otherwise — every other
 * content type stays byte-identical.
 */
function withBadge(
  body: ReadableStream,
  contentType: string,
  badge: RenderedBadge | undefined,
): ReadableStream | null {
  return badge !== undefined && injectsBadge(contentType)
    ? injectBadge(body, badge.html)
    : body;
}

/**
 * `/_kept/*` on a `live` page. Only `/_kept/readme` can exist, and only while the
 * manifest says the page has one (Q6) — then it is one R2 read of a page kept
 * rendered itself, so `kept-own` (strict CSP, no script) and no badge. Anything
 * else under `/_kept/` is the branded 404 without touching R2.
 */
async function serveKeptPath(
  c: AppContext,
  manifest: KvManifest,
  pathname: string,
  pageCacheControl: string,
): Promise<Response> {
  if (pathname !== README_PATH || manifest.badge?.readme !== true) {
    return systemPage(c, "notFound");
  }

  const fetched = await fetchReadme(c.env.KEPT_R2, manifest, c.req.header("if-none-match"));
  if (fetched.kind === "object") {
    return buildResponse(fetched.object.body, {
      status: 200,
      kind: "kept-own",
      headers: {
        "Content-Type": fetched.contentType,
        ETag: fetched.etag,
        "Cache-Control": pageCacheControl,
      },
    });
  }
  if (fetched.kind === "notModified") {
    return buildResponse(null, {
      status: 304,
      kind: "kept-own",
      headers: { ETag: fetched.etag, "Cache-Control": pageCacheControl },
    });
  }
  return systemPage(c, "notFound");
}

/**
 * Steps 3–6: everything downstream of the cache lookup, for a resolved slug.
 *
 * Split out so the caller has exactly ONE cache-store site — every store read in
 * the Worker happens inside this function, and every response it returns is a
 * candidate for the cache (the policy in `storeResponse` decides).
 */
async function serveSlug(
  c: AppContext,
  slug: string,
  url: URL,
): Promise<Response> {
  // Step 3: the single KV read, plus — ONLY on a miss — the single R2 probe of
  // `slugs/{slug}.json` that covers KV's eventual-consistency window, so the
  // person who just published does not open their own link and see a 404.
  // `manifest.ts` owns which outcomes open that probe; a malformed manifest is
  // not one of them. Either way, nothing servable here is still the branded 404.
  const lookup = await resolveManifest(c.env.KEPT_KV, c.env.KEPT_R2, slug);
  if (lookup.kind === "unservable") {
    return systemPage(c, "notFound");
  }

  if (lookup.kind === "redirect") {
    // A retired handle (E10 D10): the same path on the current handle's host,
    // before any R2 read. The target is a KV value, so it must pass the same
    // label guard a request host does before it becomes a `Location`; the host
    // suffix and scheme come from configuration, never from the request.
    // Short-cached like the directory redirect: if the old handle is ever
    // reclaimed, the purge reaches only the URLs the write side knows, so a
    // year-long 301 on a deep path would outlive it.
    if (!isSlugLabel(lookup.redirectTo)) return systemPage(c, "notFound");
    return buildResponse(null, {
      status: 301,
      kind: "kept-own",
      headers: {
        Location: `https://${lookup.redirectTo}.${c.env.KEPT_BASE_DOMAIN}${url.pathname}${url.search}`,
        "Cache-Control": SHORT_EDGE_CACHE_CONTROL,
      },
    });
  }

  // A manifest read through the fallback is provisional — KV has not caught up
  // yet — so the page it produces gets the short edge TTL rather than the
  // year-long one. See `SHORT_EDGE_CACHE_CONTROL`. System pages are unaffected:
  // their policy is already short (`notFound`) or `no-store`.
  const pageCacheControl =
    lookup.source === "kv" ? LIVE_CACHE_CONTROL : FALLBACK_CACHE_CONTROL;

  // Step 4: the status branch. A TOTAL SWITCH, not an if-chain — see
  // `unhandledManifestStatus`.
  //
  // `archived` deliberately has NO branch: it is the archive-don't-delete cold
  // state and is never written to KV, so it is not a serving status and is
  // absent from `MANIFEST_STATUSES`. Do not add one.
  //
  // Serving is draft-agnostic: drafts and kept pages are both `live`. There is
  // no `expires_at` here and no date arithmetic anywhere in the Worker —
  // `expired` is a status the control plane writes, not one the edge computes.
  switch (lookup.manifest.status) {
    case "live": {
      if (url.pathname.startsWith(KEPT_PATH_PREFIX)) {
        return serveKeptPath(c, lookup.manifest, url.pathname, pageCacheControl);
      }

      // The badge travels in the manifest (E10 D3) — rendering it costs no
      // store read. Its hash scopes the conditional in `r2.ts` (Risk 1).
      const badge =
        lookup.manifest.badge === undefined
          ? undefined
          : renderBadge(lookup.manifest.badge, {
              apexOrigin: c.env.KEPT_APEX_ORIGIN,
              pageOrigin: `https://${slug}.${c.env.KEPT_BASE_DOMAIN}`,
              slug,
            });

      // Steps 5–6: path → key → the R2 read. `r2.ts` owns the traversal guard,
      // the key shape, D12's SPA rewrite and the two miss-only second reads;
      // this branch only turns the outcome into a response.
      const fetched = await fetchPage(
        c.env.KEPT_R2,
        lookup.manifest,
        url.pathname,
        c.req.header("if-none-match"),
        badge?.badgeHash,
      );

      if (fetched.kind === "object") {
        // Streamed straight from R2 — never buffered through `arrayBuffer()`,
        // because Worker memory is not the place to hold a whole page.
        // `Content-Type` is the Worker's own; `ETag` is R2's — or, with a
        // badge, R2's plus the badge hash — so the next request can be
        // conditional. A badged body is streamed through `HTMLRewriter`.
        return buildResponse(withBadge(fetched.object.body, fetched.contentType, badge), {
          status: 200,
          kind: "user-page",
          headers: {
            "Content-Type": fetched.contentType,
            ETag: fetched.etag,
            "Cache-Control": rewrittenCacheControl(fetched.spaRewrite, pageCacheControl),
          },
        });
      }

      if (fetched.kind === "notModified") {
        // The conditional matched inside R2's `onlyIf`, so no body crossed the
        // wire. Still exactly one R2 operation. Never stored: a 304 has no body
        // to cache, and the entry it revalidates is already in the cache.
        //
        // `user-page`, NOT `kept-own`, even though the 304 carries no body: a
        // cache updates its stored headers from the 304's, so serving the strict
        // CSP here would retroactively re-apply it to the user page already in
        // the browser's cache and break it on the next view.
        return buildResponse(null, {
          status: 304,
          kind: "user-page",
          headers: {
            ETag: fetched.etag,
            "Cache-Control": rewrittenCacheControl(fetched.spaRewrite, pageCacheControl),
          },
        });
      }

      if (fetched.kind === "directory") {
        // `/about` on a non-SPA site that has `about/index.html` (Q-new-6): the
        // trailing-slash form, query preserved, so the page's relative links
        // resolve against its own folder. Same-site and relative — never an
        // origin read off the request. Short-cached: a replace can remove the
        // folder, and this URL is not one the write side purges.
        return buildResponse(null, {
          status: 301,
          kind: "kept-own",
          headers: {
            Location: `${fetched.location}${url.search}`,
            "Cache-Control": SHORT_EDGE_CACHE_CONTROL,
          },
        });
      }

      if (fetched.kind === "custom404") {
        // The site's own `404.html` (D13): a stranger's bytes, so `user-page`,
        // still a 404, and short-cached like the branded one — a later publish
        // may put a page at this path. No `ETag`: it describes `404.html`, not
        // the URL asked for.
        return buildResponse(withBadge(fetched.object.body, fetched.contentType, badge), {
          status: 404,
          kind: "user-page",
          headers: {
            "Content-Type": fetched.contentType,
            "Cache-Control": SHORT_EDGE_CACHE_CONTROL,
          },
        });
      }

      // `rejected` (guarded-off path) and `missing` (manifest pointing at an
      // object never written, or already purged) are the same answer, and the
      // offending path is never echoed back.
      return systemPage(c, "notFound");
    }
    case "under_review":
    case "quarantined":
      return systemPage(c, "suspended");
    case "expired":
      return systemPage(c, "expired");
    case "removed":
      // Deliberately indistinguishable from "never existed": a removed page
      // must not be confirmable by its status code.
      return systemPage(c, "notFound");
    default:
      return systemPage(c, unhandledManifestStatus(lookup.manifest.status));
  }
}

/**
 * Step 7: hand the response to the Cache API without delaying it.
 *
 * `c.executionCtx` throws when there is no `ExecutionContext` (a direct
 * `app.request()` call rather than a real fetch event); that is a reason to skip
 * caching, not to fail the request.
 */
function cacheServed(c: AppContext, response: Response): Response {
  let ctx: WaitUntil;
  try {
    ctx = c.executionCtx;
  } catch {
    return response;
  }

  storeResponse(ctx, c.req.raw, response);
  return response;
}

app.all("*", async (c) => {
  const url = new URL(c.req.url);

  // Step 0: method gate, ahead of everything. A static serving plane answers
  // reads only, and an unsupported method must cost zero KV and zero R2 reads.
  if (!SERVABLE_METHODS.has(c.req.method)) {
    return buildResponse(null, {
      status: 405,
      kind: "kept-own",
      headers: {
        Allow: "GET, HEAD",
        "Cache-Control": NO_STORE_CACHE_CONTROL,
      },
    });
  }

  // Step 1: host → slug. Runs BEFORE any store access, so the reserved and
  // invalid branches cost zero KV and zero R2 reads.
  const resolved = resolveHost(url.hostname, c.env.KEPT_BASE_DOMAIN);

  if (resolved.kind === "reserved") {
    // Control-plane label: permanent redirect to the apex, path + query
    // preserved (the fragment is client-side and never reaches the Worker). A
    // redirect, never a proxy — the serve path does not fetch the control plane.
    return buildResponse(null, {
      status: 301,
      kind: "kept-own",
      headers: {
        Location: `${c.env.KEPT_APEX_ORIGIN}${url.pathname}${url.search}`,
      },
    });
  }

  // `invalid` — a host outside this environment's base domain, a multi-label
  // host, or a label that is not a legal slug — is a branded 404, never a thrown
  // error, never a raw 500, never a redirect. Not cached: there is no slug to
  // purge it by, and it already costs nothing.
  if (resolved.kind === "invalid") {
    return systemPage(c, "notFound");
  }

  // Step 2: the Cache API lookup — AFTER slug resolution and BEFORE the KV read,
  // so a hit costs zero KV and zero R2 operations. That ordering is the point of
  // the whole pipeline. See `cache.ts` for why the key is the bare request URL.
  const cached = await lookupCached(c.req.raw);
  if (cached) return cached;

  return cacheServed(c, await serveSlug(c, resolved.slug, url));
});

export default app;

// Re-export the serving contract type so downstream tooling/tests can reference
// it from the edge app without reaching past the @kept/shared boundary.
export type { KvManifest };
