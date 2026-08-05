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
import { kvManifestSchema, type KvManifest } from "@kept/shared";

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
  }
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
