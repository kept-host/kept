// @kept/edge — manifest resolution: the one KV read, plus the miss-only R2 probe.
//
// One KV read, one parse, and — only when KV had nothing to say — one R2 `get`
// against a slug-addressable pointer. Nothing here fetches the control plane and
// nothing here throws: a `TypeError` escaping this module would be a 500 on
// somebody's published page, which is the exact failure mode this epic exists to
// make impossible.
//
// BUDGET: exactly one `KEPT_KV.get` per cold request, plus at most one
// `KEPT_R2.get` for the pointer probe. No retry loop, no second KV key, no
// `list`, no waiting.

import { kvManifestSchema, type KvManifest } from "@kept/shared";

/**
 * `cacheTtl` for the KV read, in seconds.
 *
 * This is the primary lever on KV read cost. It places the value in
 * Cloudflare's KV edge cache — a second, much cheaper layer beneath the Cache
 * API (task 005) — so repeated cold-cache requests within one colo cost one KV
 * read per window instead of one per request. 60s is Cloudflare's minimum
 * accepted value.
 *
 * THE CONSEQUENCE, deliberately accepted: a KV *write* does not invalidate a
 * `cacheTtl` entry, so this number is the propagation floor for a status flip.
 * A moderator quarantining a page can wait up to this long even after the
 * purge-by-URL that task 005 specifies. That is why it sits at the minimum
 * rather than somewhere cheaper — moderation latency outranks KV read cost.
 */
export const MANIFEST_KV_CACHE_TTL_SECONDS = 60;

/**
 * The slug-addressable manifest pointer probed on a KV miss.
 *
 * R2 is keyed by `siteId` (`sites/{siteId}/{versionId}/{path}`), which is what
 * makes a rename a KV-only write — and which also means a KV miss leaves the
 * Worker with NO WAY to address the object from the slug alone. This pointer is
 * the only shape a KV-miss R2 fallback can take without reintroducing a
 * slug-keyed file layout.
 *
 * Its body is byte-identical to the KV manifest value. **The Worker never writes
 * it** — the write, and its ordering against the KV write, is an obligation on
 * the control plane, specified in `docs/edge-purge-contract.md` §7.3 and
 * implemented by E04. Until something writes one, every probe misses and this
 * whole path is exactly the branded 404 it was before.
 */
function pointerKey(slug: string): string {
  return `slugs/${slug}.json`;
}

/** Where a resolved manifest came from — it decides how long the response is cached. */
export type ManifestSource = "kv" | "pointer";

/**
 * Outcome of manifest resolution.
 *
 * A KV miss with no pointer, a value that is not JSON, a value that fails
 * `kvManifestSchema`, and an unparseable pointer all collapse into `unservable`
 * — there is nothing servable in any of those cases and the caller must not have
 * to tell them apart. E04 writes Postgres, then R2, then KV, so a visitor can
 * genuinely arrive mid-sequence and read a half-written manifest; treating that
 * as "nothing is published here" is both the safe answer and the honest one.
 */
export type ManifestLookup =
  | { kind: "manifest"; manifest: KvManifest; source: ManifestSource }
  | { kind: "unservable" };

const UNSERVABLE: ManifestLookup = { kind: "unservable" };

/**
 * What the KV read alone concluded.
 *
 * `miss` is deliberately NOT the same value as `unservable`: only a miss opens
 * the consistency window the pointer probe exists to cover. Both an empty key
 * and a failed binding are misses — see `resolveManifest` for why — and nothing
 * downstream needs to tell those two apart, so they are one value.
 */
type KvLookup =
  | { kind: "manifest"; manifest: KvManifest }
  | { kind: "miss" }
  | { kind: "unservable" };

const KV_MISS: KvLookup = { kind: "miss" };
const KV_UNSERVABLE: KvLookup = { kind: "unservable" };

/**
 * Parse a stored manifest value. Shared by the KV read and the pointer probe so
 * the two paths cannot drift on what counts as a valid manifest.
 */
function parseManifest(raw: string): KvManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = kvManifestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The single KV read.
 *
 * Read as `text` and parsed here rather than with `type: "json"`, because
 * `type: "json"` collapses two events the fallback MUST tell apart: a stored
 * value that is not JSON (the binding answered — a data bug) and the binding
 * itself failing (it never answered). Both throw out of `kv.get`, and only the
 * second one may open the probe.
 */
async function readManifest(kv: KVNamespace, slug: string): Promise<KvLookup> {
  let raw: string | null;

  try {
    raw = await kv.get(slug, {
      type: "text",
      cacheTtl: MANIFEST_KV_CACHE_TTL_SECONDS,
    });
  } catch (error) {
    // A binding-level failure. Logged, never rendered — and, unlike a bad value,
    // it is a miss (see `resolveManifest`).
    console.error("[edge] kv.get failed", slug, error);
    return KV_MISS;
  }

  if (raw === null) return KV_MISS;

  const manifest = parseManifest(raw);
  return manifest === null ? KV_UNSERVABLE : { kind: "manifest", manifest };
}

/**
 * The miss-only R2 probe: exactly one `get`, no retry, no `list`, no loop.
 *
 * A probe that misses, that hits a store error, or that finds unparseable JSON
 * is `unservable` — indistinguishable, to the visitor, from the 404 they would
 * have got anyway.
 */
async function readPointer(
  bucket: R2Bucket,
  slug: string,
): Promise<ManifestLookup> {
  const key = pointerKey(slug);

  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(key);
  } catch (error) {
    console.error("[edge] r2.get pointer failed", key, error);
    return UNSERVABLE;
  }

  if (object === null) return UNSERVABLE;

  let raw: string;
  try {
    // Consumes the body, so nothing is left dangling on either outcome.
    raw = await object.text();
  } catch {
    return UNSERVABLE;
  }

  const manifest = parseManifest(raw);
  return manifest === null
    ? UNSERVABLE
    : { kind: "manifest", manifest, source: "pointer" };
}

/**
 * Resolve the serving manifest for an already-validated slug: KV, then — only on
 * a miss — the pointer.
 *
 * The slug MUST come from `resolveHost` — this function does no shape checking
 * of its own, by design: an unbounded, percent-encoded or control-character
 * label must never reach `KEPT_KV.get` or `KEPT_R2.get` in the first place, so
 * the guard lives at host resolution and not at the store call. An invalid label
 * therefore still costs ZERO store operations, probe included.
 *
 * WHY A `storeError` PROBES AND A BAD VALUE DOES NOT. The probe fires when KV
 * had nothing to say — the key was empty, or KV failed to answer at all. It does
 * NOT fire when KV answered with something unparseable or schema-invalid:
 *
 *   - a bad value is a data bug, not a consistency window. It persists, so
 *     probing on it would buy a second R2 read on every request for that slug
 *     forever, and re-deriving a manifest from a stale pointer would resurrect a
 *     page the write path is mid-way through changing.
 *   - a binding failure is a KV OUTAGE — precisely the case where the pointer
 *     earns its keep, since the pointer is the only remaining copy of the
 *     manifest and R2 is still up. It is transient by nature, and the branded
 *     404 it would otherwise produce is edge-cached for 60s, so the cost of
 *     probing through an outage is bounded.
 *
 * That second decision leans on the pointer being kept in lockstep with KV —
 * written before every KV write, deleted before every KV delete. That ordering
 * is a hard obligation on the write side, written down in
 * `docs/edge-purge-contract.md` §7.3.
 */
export async function resolveManifest(
  kv: KVNamespace,
  bucket: R2Bucket,
  slug: string,
): Promise<ManifestLookup> {
  const lookup = await readManifest(kv, slug);

  if (lookup.kind === "manifest") {
    return { kind: "manifest", manifest: lookup.manifest, source: "kv" };
  }

  if (lookup.kind === "unservable") return UNSERVABLE;

  return readPointer(bucket, slug);
}
