/**
 * Shared smoke-probe helpers for the two stores the control plane WRITES:
 * R2 (page files) and KV (per-slug manifest).
 *
 * Extracted from `scripts/smoke-cloudflare.ts` (E00 task 005) so that
 * `scripts/smoke-release.ts` (E02 task 008) asserts the exact same round-trip
 * rather than reimplementing it. Both scripts must agree on what "the stores
 * are reachable" means — one definition, two callers.
 *
 * Nothing here reads a hostname or an environment name: the target environment
 * is expressed purely by which values the `R2_*` / `KV_NAMESPACE_ID` /
 * `CLOUDFLARE_API_TOKEN` variables carry. No `if (env === "prod")` anywhere.
 *
 * No secret is ever printed — details carry bucket names and truncated ids only.
 */
import { AwsClient } from "aws4fetch";

export const CF_API = "https://api.cloudflare.com/client/v4";

export type StoreResult = { name: string; pass: boolean; detail: string };

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `Missing ${name}. Set it in apps/web/.env.local (see .env.example).`,
    );
  }
  return v.trim();
}

/**
 * The two low-level store clients, shared by the round-trip probes below and by
 * `scripts/seed-edge-canary.ts` (E03 task 009). One definition of "how the
 * control plane writes R2/KV", used by everything that writes them from a
 * script — the seeder must not grow its own signing or REST code.
 *
 * Both throw on a non-2xx so callers can `try`/`catch` a whole sequence; the
 * error text carries the status and the bucket/namespace, never a credential.
 */
export interface R2Store {
  bucket: string;
  put(key: string, body: string, contentType: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

export function r2Store(): R2Store {
  const accountId = requireEnv("R2_ACCOUNT_ID");
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
  const bucket = requireEnv("R2_BUCKET_AUTO");

  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const aws = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const url = (key: string) =>
    `${endpoint}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

  return {
    bucket,
    async put(key, body, contentType) {
      const res = await aws.fetch(url(key), {
        method: "PUT",
        body,
        headers: { "content-type": contentType },
      });
      if (!res.ok) {
        throw new Error(`R2 PUT ${key} → HTTP ${res.status} on "${bucket}"`);
      }
    },
    async get(key) {
      const res = await aws.fetch(url(key), { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`R2 GET ${key} → HTTP ${res.status} on "${bucket}"`);
      }
      return res.text();
    },
    async delete(key) {
      const res = await aws.fetch(url(key), { method: "DELETE" });
      // R2 answers 204 for a delete of a key that was never there.
      if (!res.ok && res.status !== 404) {
        throw new Error(`R2 DELETE ${key} → HTTP ${res.status} on "${bucket}"`);
      }
    },
  };
}

export interface KvStore {
  namespaceId: string;
  put(key: string, value: string, contentType?: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

export function kvStore(): KvStore {
  const accountId = requireEnv("R2_ACCOUNT_ID"); // same Cloudflare account
  const namespaceId = requireEnv("KV_NAMESPACE_ID");
  const token = requireEnv("CLOUDFLARE_API_TOKEN");

  const base = `${CF_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values`;
  const auth = { authorization: `Bearer ${token}` };
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
