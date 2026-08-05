/**
 * KV manifest writes from the control plane, over the Cloudflare REST API.
 * The Worker READS this namespace through its binding; nothing at the edge ever
 * writes it, and nothing here ever reads back through the Worker.
 *
 * Promoted from `scripts/lib/smoke-stores.ts` (E00 task 005) unchanged in
 * behaviour — the REST shape and the token scope are already proven against dev.
 *
 * DO NOT CALL THIS DIRECTLY TO WRITE A MANIFEST. Every manifest mutation goes
 * through `lib/storage/manifest.ts` (task 004), which owns the contract §7.3
 * ordering — pointer → KV → purge — in one place. A `kv.put(slug, …)` anywhere
 * else writes a manifest with no pointer and no purge, which is exactly the
 * stale-edge / resurrected-page failure that helper exists to prevent.
 *
 * Stateless and constructed at call time: no module-level singleton, so no
 * credential survives a hot reload.
 */
import { CF_API, kvConfig } from "./env";

export interface KvStore {
  namespaceId: string;
  put(key: string, value: string, contentType?: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
  // No `list`. Same reason as R2: Postgres is the authority on which slugs
  // should exist (contract §7.5), and a KV listing is both paginated and
  // eventually consistent, so it can only ever produce a misleading answer.
}

export function kvStore(): KvStore {
  const { accountId, namespaceId, apiToken } = kvConfig();

  const base = `${CF_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values`;
  const auth = { authorization: `Bearer ${apiToken}` };
  const url = (key: string) => `${base}/${encodeURIComponent(key)}`;
  const scopeHint = (status: number) =>
    status === 401 || status === 403
      ? ' — token likely missing "Workers KV Storage: Edit"'
      : "";

  return {
    namespaceId,
    async put(key, value, contentType = "text/plain") {
      const res = await fetch(url(key), {
        method: "PUT",
        headers: { ...auth, "content-type": contentType },
        body: value,
      });
      if (!res.ok) {
        throw new Error(`KV PUT ${key} → HTTP ${res.status}${scopeHint(res.status)}`);
      }
    },
    async get(key) {
      const res = await fetch(url(key), { method: "GET", headers: auth });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`KV GET ${key} → HTTP ${res.status}${scopeHint(res.status)}`);
      }
      return res.text();
    },
    async delete(key) {
      const res = await fetch(url(key), { method: "DELETE", headers: auth });
      if (!res.ok && res.status !== 404) {
        throw new Error(`KV DELETE ${key} → HTTP ${res.status}${scopeHint(res.status)}`);
      }
    },
  };
}
