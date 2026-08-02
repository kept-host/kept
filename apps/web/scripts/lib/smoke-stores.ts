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

  const key = `__smoke__/${Date.now()}-${crypto.randomUUID()}.txt`;
  const url = `${endpoint}/${bucket}/${key}`;
  const payload = `kept-r2-smoke ${crypto.randomUUID()}`;

  try {
    const put = await aws.fetch(url, {
      method: "PUT",
      body: payload,
      headers: { "content-type": "text/plain" },
    });
    if (!put.ok) {
      return {
        name: "R2",
        pass: false,
        detail: `PUT failed (HTTP ${put.status}) on bucket "${bucket}"`,
      };
    }

    const get = await aws.fetch(url, { method: "GET" });
    if (!get.ok) {
      return {
        name: "R2",
        pass: false,
        detail: `GET failed (HTTP ${get.status})`,
      };
    }
    const readBack = await get.text();
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
      detail: `round-trip OK on bucket "${bucket}"`,
    };
  } finally {
    // Best-effort cleanup; never throw from here.
    await aws.fetch(url, { method: "DELETE" }).catch(() => undefined);
  }
}

/**
 * KV control-plane round-trip via the Cloudflare REST API (Workers KV Storage).
 * PUT a key, GET it back, assert equality, then DELETE. Token needs
 * "Workers KV Storage: Edit".
 */
export async function smokeKv(): Promise<StoreResult> {
  const accountId = requireEnv("R2_ACCOUNT_ID"); // same Cloudflare account
  const namespaceId = requireEnv("KV_NAMESPACE_ID");
  const token = requireEnv("CLOUDFLARE_API_TOKEN");

  const base = `${CF_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values`;
  const key = `__smoke__:${Date.now()}-${crypto.randomUUID()}`;
  const value = `kept-kv-smoke ${crypto.randomUUID()}`;
  const auth = { authorization: `Bearer ${token}` };
  const url = `${base}/${encodeURIComponent(key)}`;

  try {
    const put = await fetch(url, {
      method: "PUT",
      headers: { ...auth, "content-type": "text/plain" },
      body: value,
    });
    if (!put.ok) {
      const hint =
        put.status === 403 || put.status === 401
          ? ' — token likely missing "Workers KV Storage: Edit"'
          : "";
      return {
        name: "KV",
        pass: false,
        detail: `PUT failed (HTTP ${put.status})${hint}`,
      };
    }

    const get = await fetch(url, { method: "GET", headers: auth });
    if (!get.ok) {
      return {
        name: "KV",
        pass: false,
        detail: `GET failed (HTTP ${get.status})`,
      };
    }
    const readBack = await get.text();
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
      detail: `round-trip OK on namespace ${namespaceId.slice(0, 6)}…`,
    };
  } finally {
    await fetch(url, { method: "DELETE", headers: auth }).catch(
      () => undefined,
    );
  }
}
