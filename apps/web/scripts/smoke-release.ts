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
 * SCOPE — what this probe proves, and what it still does not (E03 task 009)
 *
 * PROVEN as of E03: the serving data plane **serves**. The edge assertion below
 * fetches a real page out of R2 via the Worker and asserts status, body bytes,
 * `Content-Type`, `ETag` and the conditional 304 — not merely that something
 * well-formed answers on the route.
 *
 * TODO(E04): the *publish* half. The page it asserts is the canary from
 * `scripts/seed-edge-canary.ts`, written into R2 + KV by hand, because there is
 * no publish path until E04. What is still unproven is that a page published
 * *through the control plane* reaches those stores in the right shape. When E04
 * lands, replace the seeded fixture with: publish a fixture page through the
 * publish API, assert the same things here, then delete it. The assertions in
 * `smokeEdge` do not change — only where the fixture comes from.
 * ---------------------------------------------------------------------------
 */
import { setTimeout as sleep } from "node:timers/promises";

import { config } from "dotenv";
import postgres from "postgres";

import { requireEnv, requireUrl } from "./lib/cli-args";
import {
  canaryHtml,
  canarySlug,
  CANARY_CONTENT_TYPE,
} from "./lib/edge-canary";
import {
  line,
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

/** Single bounded GET. Rejects on DNS/TLS/connection failure or timeout. */
async function get(
  url: string,
  deadline: number,
  headers: Record<string, string> = {},
): Promise<Response> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("overall deadline exceeded");
  return fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { "user-agent": "kept-smoke-release", ...headers },
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
 * Edge SERVE check: the deployed Worker must return the canary page out of R2.
 *
 * Asserts, in one cold GET plus one conditional GET:
 *   200 · exact body bytes · `Content-Type` · an `ETag` · 304 on revalidation.
 *
 * The 304 leg is not decoration. E03 task 008 caught the Worker forwarding a
 * browser's quoted `If-None-Match` straight into R2, which made every
 * revalidation of a cached page 404 — a permanent page looking deleted the
 * moment a visitor's browser checked on it. A test suite catches that once; this
 * catches it on every deploy.
 *
 * A 404 here almost always means the canary fixture is missing rather than the
 * Worker being broken, so the failure text says how to re-seed it.
 *
 * EACH request carries its OWN unique query string, and that is load-bearing.
 * Live pages are served `s-maxage=31536000`, and the edge cache answers a repeat
 * GET — and synthesises the 304 for a conditional one — without the Worker
 * running at all (observed on dev: `cf-cache-status: HIT`). A post-deploy smoke
 * that hit the cache would pass on a year-old entry and never touch the version
 * just deployed, and the conditional leg would be testing Cloudflare's cache
 * rather than the Worker's `If-None-Match` handling — which is precisely the
 * mistake E03 task 008 caught in its own test suite. A fresh URL forces the real
 * pipeline every time: cache miss → KV → R2. The Worker keys the cache on the
 * whole URL and resolves the R2 key from the path only, so the query changes
 * nothing else.
 */
async function smokeEdge(edgeUrl: string, deadline: number): Promise<StoreResult> {
  const name = "edge";
  const slug = canarySlug(edgeUrl);
  const expected = canaryHtml(slug);

  const freshUrl = (): string => {
    const u = new URL(edgeUrl);
    u.searchParams.set("smoke", crypto.randomUUID());
    return u.toString();
  };

  let res: Response;
  try {
    res = await get(freshUrl(), deadline);
  } catch (err) {
    return fail(name, `GET ${edgeUrl} — no HTTP response, DNS/TLS/connection (${errText(err)})`);
  }

  if (res.status >= 520) {
    await drain(res);
    return fail(
      name,
      `GET ${edgeUrl} → HTTP ${res.status} — Cloudflare origin error; no Worker is answering this route`,
    );
  }
  if (res.status !== 200) {
    await drain(res);
    return fail(
      name,
      `GET ${edgeUrl} → HTTP ${res.status} (expected 200). If 404, the canary fixture is missing: ` +
        `pnpm --filter @kept/web seed:canary --edge-url ${edgeUrl}`,
    );
  }

  const contentType = res.headers.get("content-type") ?? "";
  const etag = res.headers.get("etag");
  const body = await res.text();

  if (body !== expected) {
    return fail(
      name,
      `GET ${edgeUrl} → 200 but body is not the canary page (${body.length}B vs ${expected.length}B expected) — re-seed with seed:canary`,
    );
  }
  if (contentType !== CANARY_CONTENT_TYPE) {
    return fail(name, `GET ${edgeUrl} → 200 but Content-Type is "${contentType}"`);
  }
  if (!etag) {
    return fail(name, `GET ${edgeUrl} → 200 with no ETag; revalidation cannot work`);
  }

  let conditional: Response;
  try {
    conditional = await get(freshUrl(), deadline, { "if-none-match": etag });
  } catch (err) {
    return fail(name, `conditional GET ${edgeUrl} — no HTTP response (${errText(err)})`);
  }
  await drain(conditional);
  if (conditional.status !== 304) {
    return fail(
      name,
      `conditional GET ${edgeUrl} (If-None-Match: ${etag}) → HTTP ${conditional.status}, expected 304`,
    );
  }

  return pass(
    name,
    `GET ${edgeUrl} → 200 "${slug}" canary, ${body.length}B, ${contentType}, ETag ${etag}; revalidate → 304`,
  );
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
  console.log(
    "      NOTE: the edge check serves a HAND-SEEDED canary; the publish path is still unproven (TODO(E04)).",
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(`SMOKE FAIL — ${errText(err)}`);
  process.exit(1);
});
