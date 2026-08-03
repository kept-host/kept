/**
 * Cloudflare control-plane smoke test (task 005).
 *
 * Verifies the two data stores the control plane writes to — R2 (page files)
 * and KV (per-slug manifest) — are reachable and round-trip correctly, plus a
 * best-effort check that the `kept.host` zone + wildcard DNS are live. This is
 * the serve-path contract from one side: `apps/web` WRITES R2 + KV; `apps/edge`
 * reads them (never the reverse). See epic "one-way serve-path rule".
 *
 * The R2/KV round-trip logic lives in ./lib/smoke-stores and is shared with
 * scripts/smoke-release.ts (E02 task 008). Reads all config from
 * apps/web/.env.local — no secrets are hardcoded or printed.
 *
 *   Run:  pnpm --filter @kept/web smoke:cf
 *
 * Exit code 0 only if BOTH R2 and KV round-trips PASS. Zone/DNS is reported but
 * does not fail the run on its own (read-verification may be gated on token
 * scope; see Notes in 005.md).
 */
import { config } from "dotenv";

import {
  CF_API,
  line,
  requireEnv,
  smokeKv,
  smokeR2,
  type StoreResult,
} from "./lib/smoke-stores";

config({ path: ".env.local" });

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
