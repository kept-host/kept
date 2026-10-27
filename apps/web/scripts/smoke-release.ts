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
 * SCOPE — what this probe proves, end to end (E03 task 009, E04 task 010)
 *
 * THE SERVE HALF (E03): the serving data plane **serves**. `smokeEdge` fetches a
 * real page out of R2 via the Worker and asserts status, body bytes,
 * `Content-Type`, `ETag` and the conditional 304 — not merely that something
 * well-formed answers on the route. Its fixture is the hand-seeded canary from
 * `scripts/seed-edge-canary.ts`, which stays: it is a FIXED slug with fixed
 * bytes, so it can assert byte equality and a stable `ETag` across deploys, and
 * it keeps the serve assertion independent of the control plane being up.
 *
 * THE PUBLISH HALF (E04): `smokePublish` closes what E03 could only narrow.
 * There is a publish path now, so the smoke uses it: one page published through
 * `POST /api/publish` on the deployed control plane, asserted to serve at the
 * `live_url` the API minted, then deleted through `DELETE /api/anon/:anonToken`.
 * That is the full write chain — Postgres, R2 object, `slugs/{slug}.json`, KV,
 * purge — proven against the deployment that was just released, on every deploy.
 * It leaves nothing behind: a smoke that accumulates pages stops being runnable.
 *
 * A CLOSED deploy (`lib/launch.ts`, reported by `/api/health`) publishes only
 * with an access token or an admin session (E06a §1), so there `smokeClosed`
 * replaces it and asserts the gate (PRD §10): publish with no token and with a
 * well-formed unknown token → 404 `not_open` and no site row; `get-session`
 * with no cookie → no session and no `Set-Cookie`; the draft-reminder cron
 * without its secret → 401 (the gate passes `/api/cron/*`).
 *
 * THE LEGAL PAGES (E06a AC19, E07 AC29), on every deploy, open or closed: every
 * `LEGAL_DOCS` page must answer 200, and while any still carries a `[[`
 * placeholder the run FAILS or WARNS per `--legal-placeholders` /
 * `SMOKE_LEGAL_PLACEHOLDERS` (`fail` | `warn`, default `fail`). The workflow
 * hands the value in — `release.yml` `fail`, `deploy-dev.yml` `warn` — so the
 * track is never guessed from the host and a forgotten setting fails safe.
 *
 * A PAUSED deploy (`KEPT_PUBLISH_PAUSED`, E09 task 011, reported by
 * `/api/health` as `publishing: "paused"`) lands nothing, open or closed, so
 * there `smokePaused` replaces both and asserts the switch: `POST /api/publish`
 * → 503 `publishing_paused` with `Retry-After`. A paused dev still deploys.
 *
 * THE SCANNER (E07 D17, AC12): `/api/health` reports `scanner: "on" | "off"`.
 * An OPEN deploy with the scanner off has nothing but P4 between the public and
 * kept, so the same explicit track option decides it: a `fail` run (the prod
 * release) FAILS, a `warn` run (dev) warns. A closed deploy passes either way —
 * nobody can publish to it. Never decided from the host.
 *
 * There is deliberately NO hostname literal in either half. The canary's slug is
 * derived from `--edge-url`; the published page's host comes back in the API
 * response and is checked against the slug the same response returned.
 * ---------------------------------------------------------------------------
 */
import { setTimeout as sleep } from "node:timers/promises";

import { hashContent, publishResponseSchema } from "@kept/shared";
import { config } from "dotenv";
import postgres from "postgres";

import { mintAccessToken } from "../lib/access-token";
import { hasLegalPlaceholders } from "../lib/legal";
import { LEGAL_DOCS } from "../lib/legal/links";
import { KV_REPURGE_DELAY_MS } from "../lib/storage/manifest";
import { readOption, requireEnv, requireUrl } from "./lib/cli-args";
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
/**
 * Whole-run cap, including warm retries, the publish canary's serve poll and its
 * takedown poll. The publish leg is sequential after the parallel ones and can
 * spend up to `PUBLISH_SERVE_TIMEOUT_MS` waiting for a brand-new page to answer
 * and then up to `PUBLISH_GONE_TIMEOUT_MS` waiting for the deleted one to stop.
 *
 * The takedown poll is why this is minutes rather than seconds: a delete cannot
 * be observed faster than the edge's KV read cache lets it be observed
 * (`KV_REPURGE_DELAY_MS`), and asserting it any sooner would only re-green the
 * bug this check exists for.
 */
const OVERALL_DEADLINE_MS = 300_000;

/** How long a page published seconds ago gets to serve before this is a failure. */
const PUBLISH_SERVE_TIMEOUT_MS = 30_000;
const PUBLISH_SERVE_INTERVAL_MS = 1_500;

/**
 * How long a DELETED page gets to stop serving on its BARE url before this is a
 * failure — the re-purge window plus slack for it to land.
 */
const PUBLISH_GONE_TIMEOUT_MS = KV_REPURGE_DELAY_MS + 25_000;
const PUBLISH_GONE_INTERVAL_MS = 3_000;

/**
 * Railway runs the dev service with Serverless enabled (task 003) and documents
 * that the first request to a slept service may return 502 while it wakes.
 * Retrying ONLY these statuses keeps that from being a false red without
 * masking a genuine 500 — anything else asserts immediately.
 */
const WARM_RETRY_STATUSES = new Set([502, 503, 504]);
const WARM_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

/** What a `[[` placeholder in a legal page does to this run (AC19). */
const LEGAL_PLACEHOLDER_POLICIES = ["fail", "warn"] as const;
type LegalPlaceholderPolicy = (typeof LEGAL_PLACEHOLDER_POLICIES)[number];

function legalPlaceholderPolicy(): LegalPlaceholderPolicy {
  const raw = readOption("legal-placeholders", "SMOKE_LEGAL_PLACEHOLDERS") ?? "fail";
  const policy = LEGAL_PLACEHOLDER_POLICIES.find((p) => p === raw);
  if (!policy) {
    throw new Error(`--legal-placeholders/SMOKE_LEGAL_PLACEHOLDERS must be "fail" or "warn": "${raw}"`);
  }
  return policy;
}

/** `/api/health`'s `scanner` (E07 D17). */
const SCANNER_STATES = ["on", "off"] as const;
type Scanner = (typeof SCANNER_STATES)[number];

/** `/api/health`'s `publishing` (E09 task 011). */
const PUBLISHING_STATES = ["on", "paused"] as const;
type Publishing = (typeof PUBLISHING_STATES)[number];

function fail(name: string, detail: string): StoreResult {
  return { name, pass: false, detail };
}
function pass(name: string, detail: string): StoreResult {
  return { name, pass: true, detail };
}

/** Single bounded request. Rejects on DNS/TLS/connection failure or timeout. */
async function send(
  url: string,
  deadline: number,
  init: { method: string; headers?: Record<string, string>; body?: string } = {
    method: "GET",
  },
): Promise<Response> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("overall deadline exceeded");
  return fetch(url, {
    ...init,
    redirect: "follow",
    headers: { "user-agent": "kept-smoke-release", ...init.headers },
    signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
  });
}

/** The GET case, which is most of them. */
async function get(
  url: string,
  deadline: number,
  headers: Record<string, string> = {},
): Promise<Response> {
  return send(url, deadline, { method: "GET", headers });
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
 *
 * It also carries back the deploy's launch gate (`lib/launch.ts`), which picks
 * the publish check below. Read from the deployment rather than configured
 * here, so the smoke cannot disagree with what is actually running.
 */
async function smokeWeb(
  baseUrl: string,
  deadline: number,
): Promise<StoreResult & { open?: boolean; scanner?: Scanner; publishing?: Publishing }> {
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
      open?: unknown;
      scanner?: unknown;
      publishing?: unknown;
    } | null;
    if (body?.status !== "ok") {
      return fail(name, `GET ${url} → 200 but body.status !== "ok"`);
    }
    if (typeof body.open !== "boolean") {
      return fail(name, `GET ${url} → 200 but body.open is not a boolean — is this build older than the launch gate?`);
    }
    const scanner = SCANNER_STATES.find((state) => state === body.scanner);
    if (!scanner) {
      return fail(name, `GET ${url} → 200 but body.scanner is not "on" or "off" — is this build older than E07?`);
    }
    const publishing = PUBLISHING_STATES.find((state) => state === body.publishing);
    if (!publishing) {
      return fail(name, `GET ${url} → 200 but body.publishing is not "on" or "paused" — is this build older than E09?`);
    }
    const warmed = attempt > 0 ? ` (after ${attempt} warm retr${attempt === 1 ? "y" : "ies"})` : "";
    return {
      ...pass(
        name,
        `GET ${url} → 200 {status:"ok", open:${body.open}, scanner:"${scanner}", publishing:"${publishing}"}${warmed}`,
      ),
      open: body.open,
      scanner,
      publishing,
    };
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
 * The page the publish canary publishes. UNIQUE PER RUN, deliberately: dedup is
 * per publisher and per byte content, so a fixed document would come back
 * `deduped: true` on the second deploy and the smoke would stop exercising a
 * fresh four-store write. Nothing derives a slug or a host from it — the API
 * mints those and hands them back.
 */
function publishCanaryHtml(runId: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>kept publish canary — ${runId}</title>`,
    "</head>",
    "<body>",
    `<h1>kept-publish-canary ${runId}</h1>`,
    "<p>Published through POST /api/publish by the release smoke, asserted at the",
    " edge, and deleted again in the same run. If you are reading this on a live",
    " page, a smoke run failed to clean up after itself.</p>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * PUBLISH → SERVE → DELETE, through the control plane that was just deployed.
 *
 * This is the half `smokeEdge` cannot cover. The canary it asserts is written
 * into R2 + KV by hand, so it proves the Worker reads the stores correctly and
 * says nothing about whether a publish still WRITES them correctly — a broken
 * pointer write, a missing purge or a botched manifest would leave that check
 * perfectly green. Here the fixture comes from the API: if the four-store write
 * regressed, the minted `live_url` does not serve these bytes.
 *
 * The whole chain is asserted from the response alone. No hostname literal, no
 * environment fork: the host is checked against the slug the SAME response
 * returned, so dev and prod differ only in `--web-url`.
 *
 * Runs AFTER the parallel checks, which is load-bearing on dev: `smokeWeb` warms
 * a slept Railway service through its 502s first, so this POST — which must not
 * be retried, because a retried publish is a second page — meets a service that
 * is already awake.
 */
async function smokePublish(webUrl: string, deadline: number): Promise<StoreResult> {
  const name = "publish";
  const runId = crypto.randomUUID().slice(0, 8);
  const html = publishCanaryHtml(runId);
  const publishUrl = new URL("/api/publish", webUrl).toString();

  // A bare POST with an HTML body: no cookie, no auth, no Turnstile — the
  // literal contract the PRD promises an agent.
  let res: Response;
  try {
    res = await send(publishUrl, deadline, {
      method: "POST",
      headers: { "content-type": "text/html" },
      body: html,
    });
  } catch (err) {
    return fail(name, `POST ${publishUrl} — no HTTP response (${errText(err)})`);
  }

  if (res.status !== 201) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    return fail(name, `POST ${publishUrl} → HTTP ${res.status} (expected 201) ${detail}`);
  }

  // Parsed through the SHARED schema — the same one an agent generates its
  // client from — so a field that quietly changed shape fails the release.
  const parsed = publishResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    return fail(
      name,
      `POST ${publishUrl} → 201 but the body is not the publish contract: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
        .join("; ")}`,
    );
  }
  const { live_url: liveUrl, slug, anonToken, deduped } = parsed.data;

  const minted = new URL(liveUrl);
  if (minted.protocol !== "https:") {
    return fail(name, `POST ${publishUrl} → 201 but live_url is not HTTPS: "${liveUrl}"`);
  }
  // The host must be the minted slug on whatever serving domain this track uses.
  // Checked against the SAME response, which is what keeps the literal out.
  if (!minted.host.startsWith(`${slug}.`)) {
    return fail(name, `live_url host "${minted.host}" does not carry the minted slug "${slug}"`);
  }
  if (deduped) {
    return fail(name, `POST ${publishUrl} → 201 but deduped:true — the canary bytes are not unique`);
  }

  /** Delete on the way out of every branch below. Never leave a page behind. */
  const cleanup = async (): Promise<string> => {
    const deleteUrl = new URL(`/api/anon/${anonToken}`, webUrl).toString();
    try {
      const del = await send(deleteUrl, deadline, { method: "DELETE" });
      await drain(del);
      return del.ok ? "" : `HTTP ${del.status}`;
    } catch (err) {
      return errText(err);
    }
  };

  // A brand-new page is served through `slugs/{slug}.json` until KV catches up,
  // so this is expected to answer immediately — the poll is for the network, not
  // for propagation. Each attempt carries its own query string for the reason
  // `smokeEdge` documents: the cache must never be what answers a smoke.
  const serveDeadline = Date.now() + PUBLISH_SERVE_TIMEOUT_MS;
  let served: Response | null = null;
  let lastStatus = 0;
  while (Date.now() < serveDeadline) {
    const probe = new URL(liveUrl);
    probe.searchParams.set("smoke", crypto.randomUUID());
    try {
      const attempt = await get(probe.toString(), deadline);
      if (attempt.status === 200) {
        served = attempt;
        break;
      }
      lastStatus = attempt.status;
      await drain(attempt);
    } catch (err) {
      lastStatus = 0;
      void err;
    }
    await sleep(PUBLISH_SERVE_INTERVAL_MS);
  }

  if (!served) {
    const cleanupError = await cleanup();
    return fail(
      name,
      `published ${slug} but GET ${liveUrl} never returned 200 (last: ${lastStatus || "no response"}) — the four-store write or the pointer is broken` +
        (cleanupError ? `; cleanup also failed (${cleanupError})` : ""),
    );
  }

  const body = await served.text();
  const contentType = served.headers.get("content-type") ?? "";

  // ── populate the BARE url's cache entry before deleting ────────────────────
  // Every probe above carries `?smoke=<uuid>`, so none of them touched the cache
  // entry a real visitor creates. That is deliberate for the serve check — and
  // it is exactly why this smoke could pass a build in which DELETE left the page
  // serving forever. The one GET below puts the page in the Cache API under
  // `s-maxage=31536000`, which is the state the takedown check needs to mean
  // anything.
  await drain(await get(liveUrl, deadline).catch(() => new Response(null)));

  const cleanupError = await cleanup();

  // ── the takedown check ─────────────────────────────────────────────────────
  // NO QUERY STRING. A cache-busting probe always reaches the Worker and would
  // report the delete as instantly effective while the url everyone else uses
  // keeps serving: `purge_cache` empties the Cache API but not the Worker's KV
  // read cache, so the first request after the purge can re-read the pre-delete
  // manifest and re-store the page for a year (contract §6). These probes are
  // themselves that traffic — if the control plane does not purge a second time,
  // this loop runs out its deadline on a 200 and the release fails.
  if (!cleanupError) {
    const goneDeadline = Date.now() + PUBLISH_GONE_TIMEOUT_MS;
    let stillServing = true;
    let lastError = "";
    let sawResponse = false;
    while (Date.now() < goneDeadline) {
      try {
        const attempt = await get(liveUrl, deadline);
        await drain(attempt);
        sawResponse = true;
        if (attempt.status !== 200) {
          stillServing = false;
          break;
        }
      } catch (err) {
        // A network blip is not proof the page is gone. Keep polling — but do
        // not let a run that never got an answer be reported as "still serving".
        lastError = errText(err);
      }
      await sleep(PUBLISH_GONE_INTERVAL_MS);
    }
    if (stillServing) {
      const seconds = Math.round(PUBLISH_GONE_TIMEOUT_MS / 1000);
      return fail(
        name,
        sawResponse
          ? `deleted ${slug} but GET ${liveUrl} still returned 200 after ${seconds}s — the edge is serving a deleted page and will keep doing so until it is purged by hand`
          : `deleted ${slug} but GET ${liveUrl} never answered within ${seconds}s (${lastError || "no response"}) — the takedown could not be confirmed`,
      );
    }
  }

  if (body !== html) {
    return fail(
      name,
      `GET ${liveUrl} → 200 but served ${body.length}B, not the ${html.length}B published`,
    );
  }
  if (!contentType.startsWith("text/html")) {
    return fail(name, `GET ${liveUrl} → 200 with Content-Type "${contentType}"`);
  }
  if (cleanupError) {
    // Not a warning. The next run publishes another one, and a smoke that
    // accumulates live pages stops being runnable.
    return fail(
      name,
      `published and served ${slug}, but DELETE failed (${cleanupError}) — the page is still live and must be deleted by hand`,
    );
  }

  return pass(
    name,
    `POST /api/publish → 201 "${slug}", ${body.length}B served at ${minted.host}, then deleted and confirmed gone at the bare url`,
  );
}

/**
 * The publish check on a CLOSED deploy (`lib/launch.ts`, E06a PRD §10).
 *
 * Every probe is one that cannot leave anything behind on a deploy whose gate
 * holds: the no-token publish sends an EMPTY body (were the gate down it would be
 * refused 400 `empty_page`), and the unknown-token publish sends unique canary
 * bytes whose content hash is then looked up in `sites` — the "no site row"
 * half of the PRD. Should that publish ever answer 201, the page is deleted
 * through its own anon token before this fails.
 */
async function smokeClosed(webUrl: string, deadline: number): Promise<StoreResult> {
  const name = "closed";
  const publishUrl = new URL("/api/publish", webUrl).toString();
  const html = publishCanaryHtml(crypto.randomUUID().slice(0, 8));
  // Well-formed and freshly minted, so it is in no deploy's KEPT_ACCESS_TOKEN_HASHES.
  const { token: unknownToken } = await mintAccessToken();

  const publishProbes: { label: string; headers: Record<string, string>; body: string }[] = [
    { label: "no token", headers: { "content-type": "text/html" }, body: "" },
    {
      label: "unknown token",
      headers: { "content-type": "text/html", authorization: `Bearer ${unknownToken}` },
      body: html,
    },
  ];
  for (const { label, ...init } of publishProbes) {
    let res: Response;
    try {
      res = await send(publishUrl, deadline, { method: "POST", ...init });
    } catch (err) {
      return fail(name, `POST ${publishUrl} (${label}) — no HTTP response (${errText(err)})`);
    }
    const body = (await res.json().catch(() => null)) as { error?: unknown; anonToken?: unknown } | null;
    if (res.status === 201 && typeof body?.anonToken === "string") {
      const del = await send(new URL(`/api/anon/${body.anonToken}`, webUrl).toString(), deadline, {
        method: "DELETE",
      }).catch(() => null);
      if (del) await drain(del);
    }
    if (res.status !== 404 || body?.error !== "not_open") {
      return fail(
        name,
        `POST ${publishUrl} (${label}) → HTTP ${res.status} on a closed deploy (expected 404 not_open) — the launch gate is not holding`,
      );
    }
  }

  const rows = await withSql((sql) =>
    hashContent(html).then((hash) => sql<{ n: number }[]>`select count(*)::int as n from sites where content_hash = ${hash}`),
  ).catch((err: unknown) => err);
  if (!Array.isArray(rows)) {
    return fail(name, `could not check for a site row after the unknown-token publish — ${errText(rows)}`);
  }
  if (rows[0]?.n !== 0) {
    return fail(name, `the unknown-token publish answered 404 but left ${rows[0]?.n} site row(s)`);
  }

  const sessionUrl = new URL("/api/auth/get-session", webUrl).toString();
  let session: Response;
  try {
    session = await send(sessionUrl, deadline);
  } catch (err) {
    return fail(name, `GET ${sessionUrl} — no HTTP response (${errText(err)})`);
  }
  const cookies = session.headers.getSetCookie().length;
  const sessionBody: unknown = await session.json().catch(() => undefined);
  if (!session.ok || sessionBody !== null || cookies > 0) {
    return fail(
      name,
      `GET ${sessionUrl} with no cookie → HTTP ${session.status}, ${sessionBody === null ? "no session" : "a non-null body"}, ${cookies} Set-Cookie (expected 200, null, none)`,
    );
  }

  const cronUrl = new URL("/api/cron/draft-reminder", webUrl).toString();
  let cron: Response;
  try {
    cron = await send(cronUrl, deadline, { method: "POST" });
  } catch (err) {
    return fail(name, `POST ${cronUrl} — no HTTP response (${errText(err)})`);
  }
  await drain(cron);
  if (cron.status !== 401) {
    return fail(name, `POST ${cronUrl} without the secret → HTTP ${cron.status} (expected 401 — the gate must pass /api/cron/*)`);
  }

  return pass(
    name,
    "closed (waitlist): publish with no token and an unknown token → 404 not_open, no site row; get-session → null, no Set-Cookie; cron → 401",
  );
}

/**
 * A paused deploy (E09 task 011): the pause is every publish route's first
 * action, so `POST /api/publish` answers 503 `publishing_paused` with
 * `Retry-After` and writes nothing. The probe carries a freshly minted (so
 * unknown) access token only so a CLOSED deploy's middleware lets it reach the
 * handler; its body is empty, so were the pause down nothing could publish.
 */
async function smokePaused(webUrl: string, deadline: number): Promise<StoreResult> {
  const name = "paused";
  const publishUrl = new URL("/api/publish", webUrl).toString();
  const { token } = await mintAccessToken();
  let res: Response;
  try {
    res = await send(publishUrl, deadline, {
      method: "POST",
      headers: { "content-type": "text/html", authorization: `Bearer ${token}` },
      body: "",
    });
  } catch (err) {
    return fail(name, `POST ${publishUrl} — no HTTP response (${errText(err)})`);
  }
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const retryAfter = res.headers.get("retry-after");
  if (res.status !== 503 || body?.error !== "publishing_paused" || !retryAfter) {
    return fail(
      name,
      `POST ${publishUrl} → HTTP ${res.status} ${String(body?.error)}, Retry-After ${retryAfter ?? "absent"} on a paused deploy (expected 503 publishing_paused with Retry-After) — the pause is not holding`,
    );
  }
  return pass(name, `paused: POST /api/publish → 503 publishing_paused, Retry-After ${retryAfter}`);
}

/**
 * The legal pages (AC19): both must answer 200, and a `[[` placeholder fails a
 * `fail` run and only warns a `warn` one (dev keeps its DRAFT banner). Follows
 * redirects, so `--web-url` on `app.` reaches the apex pages.
 */
async function smokeLegal(
  webUrl: string,
  deadline: number,
  policy: LegalPlaceholderPolicy,
): Promise<StoreResult> {
  const name = "legal";
  const withPlaceholders: string[] = [];
  for (const doc of LEGAL_DOCS) {
    const url = new URL(`/legal/${doc}`, webUrl).toString();
    let res: Response;
    try {
      res = await get(url, deadline);
    } catch (err) {
      return fail(name, `GET ${url} — no HTTP response (${errText(err)})`);
    }
    if (res.status !== 200) {
      await drain(res);
      return fail(name, `GET ${url} → HTTP ${res.status} (expected 200)`);
    }
    if (hasLegalPlaceholders(await res.text())) withPlaceholders.push(`/legal/${doc}`);
  }

  if (withPlaceholders.length === 0) {
    return pass(name, `${LEGAL_DOCS.map((doc) => `/legal/${doc}`).join(", ")} → 200, no [[ placeholders`);
  }
  const detail = `${withPlaceholders.join(", ")} still contain [[ placeholders — fill content/legal/*.md (and the sha256 pins in lib/legal/legal.test.ts)`;
  return policy === "fail" ? fail(name, detail) : { ...pass(name, `${detail} (warn on this track)`), warn: true };
}

/**
 * The scanner gate (AC12): an open deploy with the scanner off fails a `fail`
 * run and warns a `warn` one. Read from the deploy's own health answer, so it
 * cannot disagree with what is running; an unreadable health has already
 * failed `web`.
 */
function smokeScanner(
  web: { open?: boolean; scanner?: Scanner },
  policy: LegalPlaceholderPolicy,
): StoreResult {
  const name = "scanner";
  if (web.scanner === undefined) return fail(name, "no scanner state — /api/health did not answer it (see web)");
  if (web.scanner === "on") return pass(name, `scanner on (open:${web.open})`);
  if (web.open !== true) return pass(name, "scanner off on a closed deploy — nobody can publish to it");
  const detail =
    "the deploy is OPEN and the scanner is OFF — set OPENROUTER_API_KEY on this track (E07 D17); only P4 is flagging pages";
  return policy === "fail" ? fail(name, detail) : { ...pass(name, `${detail} (warn on this track)`), warn: true };
}

/**
 * Neon reachability: a trivial `SELECT 1` over the runtime (pooled) URL, which
 * is PgBouncer in transaction mode — hence `prepare: false`, matching
 * lib/db/index.ts. Proves the deployed control plane's database is actually
 * reachable post-migrate. The connection is closed explicitly in `finally` so
 * the probe cannot leave the process hanging.
 */
async function withSql<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(requireEnv("DATABASE_URL"), {
    prepare: false, // PgBouncer transaction mode — same as the runtime client.
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    onnotice: () => undefined,
  });
  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

async function smokeNeon(): Promise<StoreResult> {
  const name = "neon";
  const host = new URL(requireEnv("DATABASE_URL")).hostname;
  const endpoint = host.includes("-pooler.") ? "pooled" : "direct(!)";

  try {
    const rows = await withSql((sql) => sql<{ ok: number }[]>`select 1 as ok`);
    if (rows[0]?.ok !== 1) {
      return fail(name, `SELECT 1 returned an unexpected row on ${endpoint} endpoint`);
    }
    return pass(name, `SELECT 1 OK on ${endpoint} endpoint (${host.slice(0, 10)}…)`);
  } catch (err) {
    return fail(name, `SELECT 1 failed on ${endpoint} endpoint — ${errText(err)}`);
  }
}

async function main(): Promise<void> {
  const webUrl = requireUrl("web-url", "SMOKE_WEB_URL");
  const edgeUrl = requireUrl("edge-url", "SMOKE_EDGE_URL");
  const legalPolicy = legalPlaceholderPolicy();
  const deadline = Date.now() + OVERALL_DEADLINE_MS;

  console.log("kept · release smoke test\n");
  console.log(`      web:  ${webUrl}`);
  console.log(`      edge: ${edgeUrl}`);
  console.log(`      legal placeholders / scanner off: ${legalPolicy}\n`);

  const [web, ...stores] = await Promise.all([
    smokeWeb(webUrl, deadline),
    smokeEdge(edgeUrl, deadline),
    smokeR2(),
    smokeKv(),
    smokeNeon(),
    smokeLegal(webUrl, deadline, legalPolicy),
  ]);
  const results: StoreResult[] = [web, ...stores, smokeScanner(web, legalPolicy)];

  // Sequential, and last: it publishes a real page, and it wants the control
  // plane already warmed by `smokeWeb` because its POST must not be retried.
  // A closed deploy has nothing to publish, so it proves the gate instead. An
  // unknown gate (health failed) runs the open check, which fails loudly.
  // A paused deploy lands nothing either way, so it proves the pause instead.
  const paused = web.publishing === "paused";
  const closed = web.open === false;
  results.push(
    paused
      ? await smokePaused(webUrl, deadline)
      : closed
        ? await smokeClosed(webUrl, deadline)
        : await smokePublish(webUrl, deadline),
  );

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
    "      Both halves are covered: the edge check serves the hand-seeded canary,",
  );
  console.log(
    paused
      ? "      and the paused check proves this deploy answers every publish 503 publishing_paused."
      : closed
      ? "      and the closed check proves this deploy publishes nothing without a token and signs nobody in."
      : "      and the publish check writes a page through the API, serves it and deletes it.",
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(`SMOKE FAIL — ${errText(err)}`);
  process.exit(1);
});
