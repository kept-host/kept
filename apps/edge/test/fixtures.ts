// @kept/edge test fixtures — real KV manifests, real R2 objects, real counters.
//
// NOTHING HERE IS A MOCK. `seedManifest` writes into the same `KEPT_KV` binding
// the Worker reads, `seedObject` writes into the same `KEPT_R2` bucket, and
// `countingEnv` returns a Proxy that increments a counter and then delegates to
// the untouched binding. The Worker under test cannot tell the difference — which
// is the point, because the read-count assertion is only meaningful if the reads
// it counts are the real ones.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";

import type { KvManifest, ManifestStatus } from "@kept/shared";

import type { Env } from "../src/env";
import worker from "../src/index";

/** Serving suffix under test, straight from `[env.dev.vars]` — never a literal. */
export const BASE_DOMAIN = env.KEPT_BASE_DOMAIN;

/** Control-plane origin reserved labels 301 to, straight from `[env.dev.vars]`. */
export const APEX_ORIGIN = env.KEPT_APEX_ORIGIN;

/* ───────────────────────────────────────────────────────────────────────────
   Manifests and objects
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * A manifest with every field the `kvManifestSchema` requires. Tests override
 * only what they are actually exercising, so an added field breaks one place.
 */
export function manifest(overrides: Partial<KvManifest> = {}): KvManifest {
  return {
    siteId: "site-fixture",
    versionId: "v1",
    status: "live",
    region: "auto",
    ownerId: null,
    updatedAt: 1_770_000_000_000,
    ...overrides,
  };
}

/** The R2 key shape the Worker builds: `sites/{siteId}/{versionId}/{path}`. */
export function objectKey(m: KvManifest, path = "index.html"): string {
  return `sites/${m.siteId}/${m.versionId}/${path}`;
}

/** Distinctive page body per slug, so a wrong-page bug is visible in the diff. */
export function pageHtml(slug: string): string {
  return `<!doctype html><html><head><title>${slug}</title><style>body{color:#111}</style></head><body><h1>${slug}</h1><script>console.log(${JSON.stringify(slug)})</script></body></html>`;
}

/** Write a manifest into the real KV namespace under `slug`. */
export async function seedManifest(slug: string, m: KvManifest): Promise<void> {
  await env.KEPT_KV.put(slug, JSON.stringify(m));
}

/** Write a raw (possibly invalid) KV value, for the schema/JSON failure paths. */
export async function seedRawManifest(slug: string, raw: string): Promise<void> {
  await env.KEPT_KV.put(slug, raw);
}

/**
 * Write the object a manifest points at.
 *
 * `contentType` defaults to a deliberately hostile value: every byte in R2 was
 * uploaded by a stranger, and the Worker must answer with its own extension-
 * derived type rather than echoing `httpMetadata.contentType` back at the
 * browser. Tests that assert `Content-Type` rely on this default being wrong.
 */
export async function seedObject(
  m: KvManifest,
  body: string,
  path = "index.html",
  contentType = "application/x-uploader-chosen",
): Promise<void> {
  await env.KEPT_R2.put(objectKey(m, path), body, {
    httpMetadata: { contentType },
  });
}

/**
 * Seed a slug end to end: manifest in KV, object in R2.
 *
 * `siteId` is derived from the slug so two fixtures can never collide on an R2
 * key, and returns the manifest so a test can compute its own object key.
 */
export async function seedSite(
  slug: string,
  overrides: Partial<KvManifest> = {},
  body = pageHtml(slug),
): Promise<KvManifest> {
  const m = manifest({ siteId: `site-${slug}`, ...overrides });
  await seedObject(m, body);
  await seedManifest(slug, m);
  return m;
}

/**
 * The slug-addressable pointer object task 007 probes on a KV miss. Its JSON
 * body is identical to the KV manifest value.
 */
export function pointerKey(slug: string): string {
  return `slugs/${slug}.json`;
}

/** Seed the fallback pointer (and its page object) WITHOUT writing to KV. */
export async function seedPointerOnly(
  slug: string,
  overrides: Partial<KvManifest> = {},
): Promise<KvManifest> {
  const m = manifest({ siteId: `site-${slug}`, ...overrides });
  await seedObject(m, pageHtml(slug));
  await env.KEPT_R2.put(pointerKey(slug), JSON.stringify(m), {
    httpMetadata: { contentType: "application/json" },
  });
  return m;
}

/** Every status the serving contract can carry, so the matrix cannot go stale. */
export const SERVING_STATUSES: readonly ManifestStatus[] = [
  "live",
  "under_review",
  "quarantined",
  "expired",
  "removed",
];

/* ───────────────────────────────────────────────────────────────────────────
   Read counting — the only honest way to prove a cache hit
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * Every store call the Worker made, with the keys it asked for.
 *
 * Keys are recorded, not just totals, because "1 R2 read" and "1 R2 read of the
 * *right* key" are different claims and the failure messages need to say which
 * one broke.
 */
export interface StoreCounts {
  kvGet: number;
  kvKeys: string[];
  r2Get: number;
  r2Keys: string[];
  /** Any other method touched on either binding, e.g. a stray `head` or `list`. */
  otherCalls: string[];
}

function emptyCounts(): StoreCounts {
  return { kvGet: 0, kvKeys: [], r2Get: 0, r2Keys: [], otherCalls: [] };
}

/** Zero a counter in place, so one test can measure two consecutive requests. */
export function resetCounts(counts: StoreCounts): void {
  const fresh = emptyCounts();
  counts.kvGet = fresh.kvGet;
  counts.kvKeys = fresh.kvKeys;
  counts.r2Get = fresh.r2Get;
  counts.r2Keys = fresh.r2Keys;
  counts.otherCalls = fresh.otherCalls;
}

/** Human-readable dump used in every read-count failure message. */
export function describeCounts(counts: StoreCounts): string {
  return [
    `KV.get x${counts.kvGet} ${JSON.stringify(counts.kvKeys)}`,
    `R2.get x${counts.r2Get} ${JSON.stringify(counts.r2Keys)}`,
    counts.otherCalls.length ? `other: ${JSON.stringify(counts.otherCalls)}` : "other: none",
  ].join(" | ");
}

/**
 * Wrap a binding so every method call is recorded and then forwarded to the real
 * implementation.
 *
 * A Proxy rather than a hand-written stand-in: the real object stays the
 * receiver, so native getters keep working and a method this suite has never
 * heard of (task 007's probe, a future `head`) is still counted instead of
 * silently disappearing.
 */
function countingProxy<T extends object>(
  target: T,
  onCall: (method: string, args: unknown[]) => void,
): T {
  return new Proxy(target, {
    get(t, prop, _receiver) {
      const value = Reflect.get(t, prop, t) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        onCall(String(prop), args);
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

/**
 * An `Env` whose two store bindings count their reads.
 *
 * The bindings themselves are the real local KV/R2 — this adds a tally, it does
 * not replace behaviour. Pass the returned `env` to `dispatch`.
 */
export function countingEnv(base: Env = env): { env: Env; counts: StoreCounts } {
  const counts = emptyCounts();

  const kv = countingProxy(base.KEPT_KV, (method, args) => {
    if (method === "get" || method === "getWithMetadata") {
      counts.kvGet += 1;
      counts.kvKeys.push(String(args[0]));
    } else {
      counts.otherCalls.push(`KV.${method}`);
    }
  });

  const r2 = countingProxy(base.KEPT_R2, (method, args) => {
    if (method === "get") {
      counts.r2Get += 1;
      counts.r2Keys.push(String(args[0]));
    } else {
      counts.otherCalls.push(`R2.${method}`);
    }
  });

  return { env: { ...base, KEPT_KV: kv, KEPT_R2: r2 }, counts };
}

/* ───────────────────────────────────────────────────────────────────────────
   Dispatch
   ─────────────────────────────────────────────────────────────────────────── */

/** Build a request against `{slug}.{BASE_DOMAIN}`. */
export function requestFor(slug: string, path = "/", init?: RequestInit): Request {
  return new Request(`https://${slug}.${BASE_DOMAIN}${path}`, init);
}

/** Build a request against an arbitrary absolute URL (host-resolution tests). */
export function requestUrl(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

/**
 * Run one request through the Worker's real fetch handler.
 *
 * `waitOnExecutionContext` is not optional: task 005 writes to the Cache API
 * inside `ctx.waitUntil`, and without awaiting it the second request in a
 * read-count assertion would race the first request's cache put and produce a
 * flake that looks like a cache bug.
 */
export async function dispatch(request: Request, testEnv: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * Evict this exact request URL from the edge cache.
 *
 * Storage is isolated per test, but the Cache API is NOT rolled back between
 * tests in the same file, so a sibling test that served the same URL leaves an
 * entry behind. Any assertion about *cold* cost has to state that it means cold
 * — otherwise it silently measures a cache hit and passes for the wrong reason.
 */
export async function evictFromCache(request: Request): Promise<void> {
  await caches.default.delete(request);
}

/** Dispatch and return the body text alongside the response, for assertions. */
export async function dispatchText(
  request: Request,
  testEnv: Env = env,
): Promise<{ response: Response; text: string }> {
  const response = await dispatch(request, testEnv);
  const text = await response.text();
  return { response, text };
}

/* ───────────────────────────────────────────────────────────────────────────
   Shared expectations
   ─────────────────────────────────────────────────────────────────────────── */

/** `<title>` fragments the branded system pages render — see `system-pages.ts`. */
export const SYSTEM_PAGE_TITLES = {
  notFound: "Nothing kept here",
  suspended: "This page is under review",
  expired: "This draft wasn't kept",
} as const;

/** Header names that must never appear on a hosted page, in any response class. */
export const FORBIDDEN_CORS_HEADERS = [
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
] as const;

/** Every header name present on a response, lowercased and sorted — for messages. */
export function headerNames(response: Response): string[] {
  return [...response.headers.keys()].map((k) => k.toLowerCase()).sort();
}

/** One-line response summary used in failure messages. */
export function describeResponse(response: Response, text?: string): string {
  const head = `${response.status} ${JSON.stringify(headerNames(response))}`;
  return text === undefined ? head : `${head} body[0..200]=${JSON.stringify(text.slice(0, 200))}`;
}
