/**
 * Smoke probes for the two stores the control plane WRITES: R2 (page files) and
 * KV (per-slug manifest). Shared by `scripts/smoke-cloudflare.ts` (E00 task 005)
 * and `scripts/smoke-release.ts` (E02 task 008) so both agree on what "the
 * stores are reachable" means — one definition, two callers.
 *
 * THE CLIENTS THEMSELVES NO LONGER LIVE HERE. E04 task 003 promoted them into
 * `apps/web/lib/storage/` so route handlers can use the same code the smoke
 * scripts have been proving against dev since E00. Scripts now import *down*
 * into app code; the re-exports below keep `./lib/smoke-stores` a stable import
 * for the probes' own callers. There is exactly one signing site in the repo.
 *
 * Nothing here reads a hostname or an environment name: the target environment
 * is expressed purely by which values the `R2_*` / `KV_NAMESPACE_ID` /
 * `CLOUDFLARE_API_TOKEN` variables carry. No `if (env === "prod")` anywhere.
 *
 * No secret is ever printed — details carry bucket names and truncated ids only.
 */
export { CF_API } from "../../lib/storage/env";
export { r2Store, type R2Store } from "../../lib/storage/r2";
export { kvStore, type KvStore } from "../../lib/storage/kv";

import { kvStore } from "../../lib/storage/kv";
import { r2Store } from "../../lib/storage/r2";

export type StoreResult = { name: string; pass: boolean; detail: string };

/** Short, secret-free banner per check. */
export function line(r: StoreResult): string {
  return `${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(10)} ${r.detail}`;
}

/**
 * R2 control-plane round-trip via the S3-compatible API (aws4fetch SigV4).
 * Writes a tiny object to the AUTO bucket, reads it back, asserts byte-equality,
 * then deletes it. Cleanup runs even if an assertion fails.
 */
export async function smokeR2(): Promise<StoreResult> {
  const r2 = r2Store();
  const key = `__smoke__/${Date.now()}-${crypto.randomUUID()}.txt`;
  const payload = `kept-r2-smoke ${crypto.randomUUID()}`;

  try {
    await r2.put(key, payload, "text/plain");
    const readBack = await r2.get(key);
    if (readBack !== payload) {
      return {
        name: "R2",
        pass: false,
        detail: "round-trip mismatch (bytes read != bytes written)",
      };
    }
    return {
      name: "R2",
      pass: true,
      detail: `round-trip OK on bucket "${r2.bucket}"`,
    };
  } catch (err) {
    return {
      name: "R2",
      pass: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Best-effort cleanup; never throw from here.
    await r2.delete(key).catch(() => undefined);
  }
}

/**
 * KV control-plane round-trip via the Cloudflare REST API (Workers KV Storage).
 * PUT a key, GET it back, assert equality, then DELETE. Token needs
 * "Workers KV Storage: Edit".
 */
export async function smokeKv(): Promise<StoreResult> {
  const kv = kvStore();
  const key = `__smoke__:${Date.now()}-${crypto.randomUUID()}`;
  const value = `kept-kv-smoke ${crypto.randomUUID()}`;

  try {
    await kv.put(key, value);
    const readBack = await kv.get(key);
    if (readBack !== value) {
      return {
        name: "KV",
        pass: false,
        detail: "round-trip mismatch (value read != value written)",
      };
    }
    return {
      name: "KV",
      pass: true,
      detail: `round-trip OK on namespace ${kv.namespaceId.slice(0, 6)}…`,
    };
  } catch (err) {
    return {
      name: "KV",
      pass: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await kv.delete(key).catch(() => undefined);
  }
}
