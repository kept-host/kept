/**
 * The manifest write helper — `docs/edge-purge-contract.md` §5 + §7.3 in one
 * place. THIS MODULE IS THE ONLY THING IN THE REPO THAT MUTATES A KV MANIFEST.
 *
 * The contract states one rule:
 *
 *   > Every KV manifest write is preceded by an identical pointer write. Every
 *   > KV manifest delete is preceded by a pointer delete. There is no manifest
 *   > mutation that touches KV and not the pointer.
 *
 * and §5 states a second one — "if the KV manifest for a slug is written, purge
 * that slug" — which the contract itself notes is the same rule seen twice:
 * a helper doing **pointer → KV → purge** satisfies both at once. That is this
 * file. `apps/edge` reads `slugs/{slug}.json` precisely when KV cannot answer,
 * so a pointer that lags KV serves content the control plane already changed.
 *
 * THE FULL CHAIN, so the ordering is readable without opening the contract:
 *
 *   publish / replace:  R2 object → slugs/{slug}.json → KV {slug} → purge
 *   delete:                        delete pointer     → delete KV  → purge
 *   rename (E06):       writeManifest(new) → removeManifest(old)
 *   status flip (E07):  writeManifest(slug, { ...manifest, status })
 *
 * …where "purge" is TWO purges, the second one delayed. One is not enough and
 * the reason is not obvious — see `repurgeAfterKvPropagation`.
 *
 * The R2 *page object* write is the caller's (E04 task 005) and happens BEFORE
 * `writeManifest`; this helper never touches `sites/{siteId}/{versionId}/…`.
 * E06 and E07 express their rows as calls to the two functions below — if they
 * ever need to reach past this module, the API here is wrong.
 *
 * A `kv.put(slug, …)` / `kv.delete(slug)` anywhere else in the repo is a bug: it
 * writes a manifest with no pointer and no purge, which is the stale-edge /
 * resurrected-page failure this exists to prevent. `apps/web/eslint.config.mjs`
 * carries a `no-restricted-imports` rule that makes importing the KV client
 * outside this module a lint error.
 *
 * NO MODULE-LEVEL STORE CLIENTS. `r2Store()` / `kvStore()` re-read and re-
 * validate the environment on every call (see `./env`); hoisting one into a
 * const would pin a rotated credential for the life of the process.
 */
import { setTimeout as sleep } from "node:timers/promises";

import {
  kvManifestSchema,
  MANIFEST_KV_CACHE_TTL_SECONDS,
  type KvManifest,
} from "@kept/shared";

import { servingBaseDomain } from "./env";
import { kvStore } from "./kv";
import { purgeUrls, type PurgeResult } from "./purge";
import { r2Store } from "./r2";

/**
 * `slugs/{slug}.json` — the pointer object the Worker probes on a KV miss
 * (contract §7.2). A pure key formatter; it touches no store. The two ENTRY
 * POINTS that mutate a manifest are `writeManifest` and `removeManifest`.
 */
export function pointerKey(slug: string): string {
  return `slugs/${slug}.json`;
}

/**
 * Both URL forms the Worker can serve a slug under (contract §4). `purge_cache`
 * matches the URL string exactly, so `/` and `/index.html` are two separate
 * cache entries even though they resolve to the same R2 object — purging one and
 * not the other leaves a stale edge for up to a year. Pure; touches no store.
 *
 * Throws if `KEPT_BASE_DOMAIN` is unset or malformed. Callers inside this module
 * catch that, because a config gap must degrade to a logged purge failure and
 * never to a failed publish.
 */
export function slugPurgeUrls(slug: string): string[] {
  const base = servingBaseDomain();
  return [`https://${slug}.${base}/`, `https://${slug}.${base}/index.html`];
}

/**
 * Which step failed, so the caller's rollback can unwind precisely:
 * `validate` and `pointer` ⇒ nothing was written, nothing to unwind;
 * `kv` ⇒ the pointer IS written and must be removed (`removeManifest` is the
 * inverse of the whole sequence and is the intended unwind).
 */
export type ManifestWriteStep = "validate" | "pointer" | "kv";
export type ManifestRemoveStep = "pointer" | "kv";

export type ManifestWriteResult =
  | {
      ok: true;
      /** The exact bytes written to BOTH stores. */
      value: string;
      /** Non-fatal by contract §3/§5 — `ok: false` here still means published. */
      purge: PurgeResult;
    }
  | { ok: false; step: ManifestWriteStep; error: string };

export type ManifestRemoveResult =
  | { ok: true; purge: PurgeResult }
  | { ok: false; step: ManifestRemoveStep; error: string };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * How long after a successful purge the SECOND purge is issued.
 *
 * TWICE the edge's KV `cacheTtl`, plus five seconds of slack, and the factor of
 * two is the proof rather than padding. At the moment a manifest changes, the
 * colo's KV entry has between 0 and `MANIFEST_KV_CACHE_TTL_SECONDS` of life
 * left, so the one stale read can happen as late as T+ttl and refreshes the
 * entry to T+2·ttl. Past that the next KV read is authoritative.
 */
export const KV_REPURGE_DELAY_MS = (2 * MANIFEST_KV_CACHE_TTL_SECONDS + 5) * 1000;

/**
 * The SECOND purge — issued once the edge's KV read cache can no longer answer
 * with the pre-change manifest.
 *
 * ⚠️ ONE PURGE IS NOT ENOUGH, and contract §6 understates why. `purge_cache`
 * empties the Cache API but does NOT reach the Worker's KV read cache
 * (`cacheTtl: MANIFEST_KV_CACHE_TTL_SECONDS`). So the first request after a
 * purge re-reads the OLD manifest, and the Worker stores that old response under
 * `LIVE_CACHE_CONTROL` — `s-maxage=31536000`. §6 calls this a "60-second tail",
 * but the tail never ends: nothing expires the re-stored entry, and while it
 * answers, no further KV read ever happens to correct it. One purge therefore
 * converts a bounded propagation window into a PERMANENT stale edge.
 *
 * Measured on deployed dev, 2026-08-05, `DELETE /api/sites/:token`: the KV key
 * and the pointer were both gone and a cache-busting URL 404'd, yet three
 * seconds after the delete the live URL was a cache MISS serving 200 with
 * `s-maxage=31536000` — the purge had landed and the deleted page had just been
 * re-cached for a year. It was still serving 200 minutes later, while its
 * `/index.html` form (purged, never re-requested, so never re-poisoned) 404'd.
 *
 * Only ONE stale read is possible per purge, which is what makes a single retry
 * sufficient rather than a loop: once the response is back in the Cache API it
 * answers every request, so nothing refreshes the KV entry again.
 *
 * Exported for the drill in `./manifest.test.ts`, which calls it with a zero
 * delay. `ref: false` so a pending re-purge never holds a process open. It does
 * NOT survive a restart or a redeploy — the durable, queue-backed retry contract
 * §3 asks for is E07's.
 */
export async function repurgeAfterKvPropagation(
  slug: string,
  urls: readonly string[],
  delayMs: number = KV_REPURGE_DELAY_MS,
): Promise<PurgeResult> {
  await sleep(delayMs, undefined, { ref: false });

  const result = await purgeUrls(urls);
  if (!result.ok) {
    console.error(
      `[kept] re-purge FAILED for slug "${slug}" — ${result.error}. URLs: ${urls.join(", ")}. The first purge succeeded, so the edge may be serving a response re-cached from a stale KV read; replay this purge (contract §6).`,
    );
  }
  return result;
}

/**
 * Purge both URL forms of a slug, and NEVER throw. By the time this runs the
 * stores already agree; only the edge is stale, and contract §3 is explicit that
 * a failed purge is logged, alerted and retried — not rolled back and not
 * surfaced as a publish failure. The log carries the slug and both URLs so a
 * retry can be replayed from it.
 */
async function purgeSlug(slug: string): Promise<PurgeResult> {
  let urls: string[];
  try {
    urls = slugPurgeUrls(slug);
  } catch (err) {
    const error = message(err);
    console.error(
      `[kept] purge SKIPPED for slug "${slug}" — ${error}. The stores are correct; the edge may serve a stale copy until this is configured and the purge replayed.`,
    );
    return { ok: false, error };
  }

  const result = await purgeUrls(urls);
  if (!result.ok) {
    console.error(
      `[kept] purge FAILED for slug "${slug}" — ${result.error}. URLs: ${urls.join(", ")}. The write succeeded; the edge stays stale until this is retried (contract §3).`,
    );
    // No re-purge: the first call never reached Cloudflare, so a second on the
    // same broken configuration would only log the same failure twice. Contract
    // §3's retry is the operator's, and E07 owns making it durable.
    return result;
  }

  // Floating BY DESIGN — see `repurgeAfterKvPropagation`. A delete must not
  // block for two minutes, and contract §3 forbids a purge from failing the
  // operation it follows. The `.catch` is not decoration: this promise is
  // unawaited, `purgeUrls` re-reads the environment on every call, and an
  // unhandled rejection takes the whole Node process down.
  void repurgeAfterKvPropagation(slug, urls).catch((err: unknown) => {
    console.error(
      `[kept] re-purge THREW for slug "${slug}" — ${message(err)}. The edge may be serving a response re-cached from a stale KV read; replay this purge (contract §6).`,
    );
  });
  return result;
}

/**
 * Write a manifest: **pointer → KV → purge**, awaited in that order, never
 * concurrently. The pointer must be readable BEFORE the KV entry exists or the
 * eventual-consistency window it covers is not covered at all (§7.3).
 *
 * The pointer body and the KV value come from ONE `JSON.stringify` of ONE
 * schema-parsed object, so they are byte-identical by construction rather than
 * by two serializations that happen to agree (§7.2). Validation runs before
 * either write: the Worker parses the pointer with this same schema and treats
 * an unparseable one as a branded 404, so validating here is what keeps that
 * impossible.
 */
export async function writeManifest(
  slug: string,
  manifest: KvManifest,
): Promise<ManifestWriteResult> {
  const parsed = kvManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"} — ${issue.message}`)
      .join("; ");
    return { ok: false, step: "validate", error: `invalid manifest: ${detail}` };
  }

  // ONE serialization, two stores. Do not stringify again below.
  const value = JSON.stringify(parsed.data);

  try {
    // `putJson` sets `content-type: application/json` (§7.2) and takes the
    // already-serialized string precisely so these bytes are not rebuilt.
    await r2Store().putJson(pointerKey(slug), value);
  } catch (err) {
    return { ok: false, step: "pointer", error: message(err) };
  }

  try {
    await kvStore().put(slug, value, "application/json");
  } catch (err) {
    // The pointer is written and the caller must unwind it — `removeManifest`.
    return { ok: false, step: "kv", error: message(err) };
  }

  return { ok: true, value, purge: await purgeSlug(slug) };
}

/**
 * Remove a manifest: **delete pointer → delete KV → purge**, the exact reverse
 * of the write.
 *
 * THE ORDER IS THE WHOLE POINT: deleting KV first leaves a window in which the
 * Worker misses KV, probes the still-present pointer, and RESURRECTS A DELETED
 * PAGE. That window is invisible on the happy path — while KV still answers
 * "absent" every request 404s regardless of pointer state — so a wrong-ordered
 * delete passes every test that does not force a KV miss.
 *
 * The R2 page object is the caller's to remove (or, per the pivot, to archive
 * rather than delete) and is untouched here.
 */
export async function removeManifest(slug: string): Promise<ManifestRemoveResult> {
  try {
    await r2Store().delete(pointerKey(slug));
  } catch (err) {
    return { ok: false, step: "pointer", error: message(err) };
  }

  try {
    await kvStore().delete(slug);
  } catch (err) {
    return { ok: false, step: "kv", error: message(err) };
  }

  return { ok: true, purge: await purgeSlug(slug) };
}
