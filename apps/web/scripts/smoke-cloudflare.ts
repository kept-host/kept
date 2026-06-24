/**
 * Cloudflare control-plane smoke test (task 005).
 *
 * Verifies the two data stores the control plane writes to — R2 (page files)
 * and KV (per-slug manifest) — are reachable and round-trip correctly, plus a
 * best-effort check that the `kept.host` zone + wildcard DNS are live. This is
 * the serve-path contract from one side: `apps/web` WRITES R2 + KV; `apps/edge`
 * reads them (never the reverse). See epic "one-way serve-path rule".
 *
 * Reusable by CI/ops (task 008 / E-CI), not a throwaway. Reads all config from
 * apps/web/.env.local — no secrets are hardcoded or printed.
 *
 *   Run:  pnpm --filter @kept/web smoke:cf
 *
 * Exit code 0 only if BOTH R2 and KV round-trips PASS. Zone/DNS is reported but
 * does not fail the run on its own (read-verification may be gated on token
 * scope; see Notes in 005.md).
 */
import { config } from "dotenv";
import { AwsClient } from "aws4fetch";

config({ path: ".env.local" });

const CF_API = "https://api.cloudflare.com/client/v4";

type StoreResult = { name: string; pass: boolean; detail: string };

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `Missing ${name}. Set it in apps/web/.env.local (see .env.example).`,
    );
  }
  return v.trim();
}

/** Short, secret-free banner per check. */
function line(r: StoreResult): string {
  return `${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(10)} ${r.detail}`;
}

/**
 * R2 control-plane round-trip via the S3-compatible API (aws4fetch SigV4).
 * Writes a tiny object to the AUTO bucket, reads it back, asserts byte-equality,
 * then deletes it. Cleanup runs even if an assertion fails.
 */
async function smokeR2(): Promise<StoreResult> {
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
async function smokeKv(): Promise<StoreResult> {
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

/**
 * Best-effort zone + wildcard DNS verification.
 *
 * 1. Try the Cloudflare API (needs Zone:Read on the token). If readable, assert
 *    the zone is Active and a `*.kept.host` DNS record exists.
 * 2. If the token lacks Zone:Read, fall back to DNS-over-HTTPS resolution of a
 *    test subdomain via Cloudflare's 1.1.1.1 resolver.
 *
 * Returned result is informational; it does not gate the overall exit code.
 */
async function verifyZone(): Promise<StoreResult> {
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  const zoneName = "kept.host";

  // Attempt 1: Cloudflare Zone API.
  try {
    const res = await fetch(
      `${CF_API}/zones?name=${encodeURIComponent(zoneName)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (res.ok) {
      const json = (await res.json()) as {
        result?: Array<{ id: string; status: string }>;
      };
      const zone = json.result?.[0];
      if (zone) {
        const active = zone.status === "active";
        // Try to confirm the wildcard record via the DNS API (needs DNS:Read).
        // If the token can't read DNS records, fall back to a live DoH lookup —
        // Universal SSL + a working subdomain is the real signal anyway.
        let wildcard: "present" | "absent" | "unknown" = "unknown";
        const dns = await fetch(
          `${CF_API}/zones/${zone.id}/dns_records?name=${encodeURIComponent("*." + zoneName)}`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (dns.ok) {
          const dj = (await dns.json()) as { result?: unknown[] };
          wildcard = dj.result && dj.result.length > 0 ? "present" : "absent";
        }
        if (wildcard === "unknown") {
          const live = await wildcardResolves(zoneName);
          return {
            name: "zone/DNS",
            pass: active && live,
            detail: `API: zone status=${zone.status}; DNS:Read unavailable, DoH wildcard=${live ? "resolves" : "no-resolve"}`,
          };
        }
        return {
          name: "zone/DNS",
          pass: active && wildcard !== "absent",
          detail: `API: zone status=${zone.status}, wildcard *.${zoneName}=${wildcard}`,
        };
      }
    }
    // Fall through to DNS check if 403 (no Zone:Read) or zone not in result.
  } catch {
    // Network error — fall through to DNS check.
  }

  // Attempt 2: DNS-over-HTTPS resolution (no special token scope needed).
  const test = `kept-smoke-test.${zoneName}`;
  const resolved = await wildcardResolves(zoneName);
  return {
    name: "zone/DNS",
    pass: resolved,
    detail: resolved
      ? `DoH: ${test} resolves (wildcard live); programmatic zone verify needs a Zone:Read token`
      : `DoH: ${test} did not resolve; programmatic zone verify needs a Zone:Read token`,
  };
}

/**
 * Resolve a random first-level subdomain of the zone via Cloudflare DNS-over-
 * HTTPS. A wildcard `*.kept.host` record means an arbitrary subdomain resolves.
 * Returns false on any error (network/parse) — never throws.
 */
async function wildcardResolves(zoneName: string): Promise<boolean> {
  const probe = `kept-smoke-${Date.now()}.${zoneName}`;
  try {
    const doh = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(probe)}&type=A`,
      { headers: { accept: "application/dns-json" } },
    );
    if (!doh.ok) return false;
    const dj = (await doh.json()) as { Status?: number; Answer?: unknown[] };
    return dj.Status === 0 && (dj.Answer?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log("kept · Cloudflare control-plane smoke test\n");

  const [r2, kv, zone] = await Promise.all([
    smokeR2(),
    smokeKv(),
    verifyZone(),
  ]);

  console.log(line(r2));
  console.log(line(kv));
  console.log(line(zone));

  // Only R2 + KV round-trips gate the exit code (the two stores this task
  // provisions). Zone/DNS is informational per the token-scope caveat.
  const ok = r2.pass && kv.pass;
  console.log(`\n${ok ? "SMOKE PASS" : "SMOKE FAIL"} (R2 + KV required)`);
  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`SMOKE FAIL — ${msg}`);
  process.exit(1);
});
