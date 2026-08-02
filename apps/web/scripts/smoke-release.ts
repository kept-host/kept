/**
 * Post-deploy release smoke test (E02 task 008).
 *
 * The assertion step both `deploy-dev.yml` and `release.yml` call after a
 * deploy. It is a script rather than inline YAML so dev and prod run byte-
 * identical code and the probe can be debugged locally instead of by pushing
 * tags.
 *
 *   Run:  pnpm --filter @kept/web smoke:release \
 *           --web-url https://<control-plane> --edge-url https://<slug>.<zone>
 *
 * URLs come from `--web-url` / `--edge-url` or `SMOKE_WEB_URL` / `SMOKE_EDGE_URL`.
 * Store credentials come from `R2_*`, `KV_NAMESPACE_ID`, `CLOUDFLARE_API_TOKEN`;
 * the database from `DATABASE_URL` (the *pooled* runtime URL, not the direct
 * migration URL — this checks what the running app uses). Locally these load
 * from `apps/web/.env.local`, in CI from the GitHub Environment.
 *
 * There is deliberately NO hostname literal and NO `if (env === "prod")` fork:
 * dev and prod differ only in the values handed to the same code path.
 *
 * ---------------------------------------------------------------------------
 * SCOPE — what this probe does NOT prove
 *
 * TODO(E04): replace with the publish → {slug}.kept.host → 200 canary.
 *
 * The thing the epic ultimately wants proven is that a *published page is
 * served*. That is impossible today: `apps/edge` returns a placeholder until
 * E03 and there is no publish path until E04. So the edge assertion below is
 * honest about being a *reachability* check — "something well-formed answers on
 * the route" — and is NOT a serve check. When E04 lands, replace `smokeEdge`
 * with: publish a fixture page through the control plane, GET it back from the
 * edge hostname, assert 200 + body equality, then delete it.
 * ---------------------------------------------------------------------------
 */
import { setTimeout as sleep } from "node:timers/promises";

import { config } from "dotenv";
import postgres from "postgres";

import {
  line,
  requireEnv,
  smokeKv,
  smokeR2,
  type StoreResult,
} from "./lib/smoke-stores";

config({ path: ".env.local" });

/** Per-request cap. A hung socket must not hold a release open. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Whole-run cap, including warm retries. */
const OVERALL_DEADLINE_MS = 120_000;

/**
 * Railway runs the dev service with Serverless enabled (task 003) and documents
 * that the first request to a slept service may return 502 while it wakes.
 * Retrying ONLY these statuses keeps that from being a false red without
 * masking a genuine 500 — anything else asserts immediately.
 */
const WARM_RETRY_STATUSES = new Set([502, 503, 504]);
const WARM_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

function fail(name: string, detail: string): StoreResult {
  return { name, pass: false, detail };
}
function pass(name: string, detail: string): StoreResult {
  return { name, pass: true, detail };
}

/** `--flag value`, `--flag=value`, then the env fallback. */
function readOption(flag: string, envName: string): string | undefined {
  const argv = process.argv.slice(2);
  const inline = argv.find((a) => a.startsWith(`--${flag}=`));
  if (inline) {
    const v = inline.slice(flag.length + 3).trim();
    if (v !== "") return v;
  }
  const i = argv.indexOf(`--${flag}`);
  if (i !== -1) {
    const v = argv[i + 1];
    if (v && !v.startsWith("--")) return v.trim();
  }
  const fromEnv = process.env[envName];
  return fromEnv && fromEnv.trim() !== "" ? fromEnv.trim() : undefined;
}

function requireUrl(flag: string, envName: string): string {
  const raw = readOption(flag, envName);
  if (!raw) {
    throw new Error(`Missing target URL. Pass --${flag} <url> or set ${envName}.`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL for --${flag}/${envName}: "${raw}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`--${flag}/${envName} must be http(s): "${raw}"`);
  }
  return url.toString();
}

/** Single bounded GET. Rejects on DNS/TLS/connection failure or timeout. */
async function get(url: string, deadline: number): Promise<Response> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("overall deadline exceeded");
  return fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { "user-agent": "kept-smoke-release" },
    signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
  });
}

/** Release the socket for a response whose body we are about to discard. */
async function drain(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Control plane: `/api/health` must answer 2xx with `{ status: "ok" }` — the
 * same endpoint `e2e/api-health.spec.ts` asserts on, not a second one.
 * Warms through 502/503/504 with bounded backoff; every other outcome is
 * immediate.
 */
async function smokeWeb(baseUrl: string, deadline: number): Promise<StoreResult> {
  const url = new URL("/api/health", baseUrl).toString();
  const name = "web";

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await get(url, deadline);
    } catch (err) {
      return fail(name, `GET ${url} — no HTTP response (${errText(err)})`);
    }

    if (WARM_RETRY_STATUSES.has(res.status)) {
      await drain(res);
      const backoff = WARM_BACKOFF_MS[attempt];
      if (backoff === undefined) {
        return fail(
          name,
          `GET ${url} → HTTP ${res.status} after ${WARM_BACKOFF_MS.length} warm retries (service never woke)`,
        );
      }
      console.log(
        `      warming ${url} → HTTP ${res.status}; retry ${attempt + 1}/${WARM_BACKOFF_MS.length} in ${backoff}ms`,
      );
      await sleep(backoff);
      continue;
    }

    if (!res.ok) {
      await drain(res);
      return fail(name, `GET ${url} → HTTP ${res.status} (expected 2xx)`);
    }

    const body = (await res.json().catch(() => null)) as {
      status?: string;
    } | null;
    if (body?.status !== "ok") {
      return fail(name, `GET ${url} → 200 but body.status !== "ok"`);
    }
    const warmed = attempt > 0 ? ` (after ${attempt} warm retr${attempt === 1 ? "y" : "ies"})` : "";
    return pass(name, `GET ${url} → 200 {status:"ok"}${warmed}`);
  }
}

/**
 * Edge reachability. ANY well-formed HTTP response from the Worker passes — the
 * placeholder/404 `apps/edge` returns until E03 counts. What must fail is
 * "nothing is answering on this route": a DNS or TLS failure, or a Cloudflare
 * origin error (52x/530), which is exactly what you get when the zone is live
 * but no Worker is bound to the route.
 *
 * TODO(E04): this is reachability, not serving. See the scope note at the top.
 */
async function smokeEdge(edgeUrl: string, deadline: number): Promise<StoreResult> {
  const name = "edge";
  let res: Response;
  try {
    res = await get(edgeUrl, deadline);
  } catch (err) {
    return fail(name, `GET ${edgeUrl} — no HTTP response, DNS/TLS/connection (${errText(err)})`);
  }
  await drain(res);

  if (res.status >= 520) {
    return fail(
      name,
      `GET ${edgeUrl} → HTTP ${res.status} — Cloudflare origin error; no Worker is answering this route`,
    );
  }
  return pass(name, `GET ${edgeUrl} → HTTP ${res.status} (Worker route reachable)`);
}

/**
 * Neon reachability: a trivial `SELECT 1` over the runtime (pooled) URL, which
 * is PgBouncer in transaction mode — hence `prepare: false`, matching
 * lib/db/index.ts. Proves the deployed control plane's database is actually
 * reachable post-migrate. The connection is closed explicitly in `finally` so
 * the probe cannot leave the process hanging.
 */
async function smokeNeon(): Promise<StoreResult> {
  const name = "neon";
  const connectionString = requireEnv("DATABASE_URL");
  const host = new URL(connectionString).hostname;
  const endpoint = host.includes("-pooler.") ? "pooled" : "direct(!)";

  const sql = postgres(connectionString, {
    prepare: false, // PgBouncer transaction mode — same as the runtime client.
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    onnotice: () => undefined,
  });

  try {
    const rows = await sql<{ ok: number }[]>`select 1 as ok`;
    if (rows[0]?.ok !== 1) {
      return fail(name, `SELECT 1 returned an unexpected row on ${endpoint} endpoint`);
    }
    return pass(name, `SELECT 1 OK on ${endpoint} endpoint (${host.slice(0, 10)}…)`);
  } catch (err) {
    return fail(name, `SELECT 1 failed on ${endpoint} endpoint — ${errText(err)}`);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const webUrl = requireUrl("web-url", "SMOKE_WEB_URL");
  const edgeUrl = requireUrl("edge-url", "SMOKE_EDGE_URL");
  const deadline = Date.now() + OVERALL_DEADLINE_MS;

  console.log("kept · release smoke test\n");
  console.log(`      web:  ${webUrl}`);
  console.log(`      edge: ${edgeUrl}\n`);

  const results = await Promise.all([
    smokeWeb(webUrl, deadline),
    smokeEdge(edgeUrl, deadline),
    smokeR2(),
    smokeKv(),
    smokeNeon(),
  ]);

  for (const r of results) console.log(line(r));

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(
      `\nSMOKE FAIL — ${failed.length}/${results.length} assertion(s) failed: ${failed
        .map((r) => r.name)
        .join(", ")}`,
    );
    process.exit(1);
  }
  console.log(`\nSMOKE PASS — ${results.length}/${results.length} assertions`);
  console.log("      NOTE: edge check is reachability only; see TODO(E04).");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(`SMOKE FAIL — ${errText(err)}`);
  process.exit(1);
});
