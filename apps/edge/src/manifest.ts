// @kept/edge — the one KV read in the request budget.
//
// One read, one parse, two outcomes. Nothing here fetches the control plane and
// nothing here throws: a `TypeError` escaping this module would be a 500 on
// somebody's published page, which is the exact failure mode this epic exists to
// make impossible.
//
// BUDGET: exactly one `KEPT_KV.get` per cold request. No retry loop, no second
// key, no fallback lookup. The direct R2 probe that covers KV's
// eventual-consistency window on a miss is task 007's; it layers on top of the
// `unservable` result this module returns rather than adding a second KV call.

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
 * Outcome of the manifest lookup.
 *
 * A miss, a value that is not JSON, and a value that fails `kvManifestSchema`
 * all collapse into `unservable` — there is nothing servable in any of those
 * cases and the caller must not have to tell them apart. E04 writes Postgres,
 * then R2, then KV, so a visitor can genuinely arrive mid-sequence and read a
 * half-written manifest; treating that as "nothing is published here" is both
 * the safe answer and the honest one.
 */
export type ManifestLookup =
  | { kind: "manifest"; manifest: KvManifest }
  | { kind: "unservable" };

const UNSERVABLE: ManifestLookup = { kind: "unservable" };

/**
 * Read and validate the serving manifest for an already-validated slug.
 *
 * The slug MUST come from `resolveHost` — this function does no shape checking
 * of its own, by design: an unbounded, percent-encoded or control-character
 * label must never reach `KEPT_KV.get` in the first place, so the guard lives at
 * host resolution and not at the store call.
 */
export async function readManifest(
  kv: KVNamespace,
  slug: string,
): Promise<ManifestLookup> {
  let value: unknown;

  try {
    value = await kv.get(slug, {
      type: "json",
      cacheTtl: MANIFEST_KV_CACHE_TTL_SECONDS,
    });
  } catch {
    // `type: "json"` throws on a stored value that is not valid JSON, and the
    // binding itself can fail. Either way there is nothing to serve, and the
    // visitor gets a branded page rather than a stack trace.
    return UNSERVABLE;
  }

  if (value === null) return UNSERVABLE;

  const parsed = kvManifestSchema.safeParse(value);
  return parsed.success
    ? { kind: "manifest", manifest: parsed.data }
    : UNSERVABLE;
}
