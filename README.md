# kept

Free, permanent, dead-simple static hosting for humans *and* AI agents. Drop an
HTML file — or let an agent publish one — and get a `{slug}.kept.host` link.
No signup required to publish. AGPL-3.0.

Every page is either a **draft** (live instantly, 7-day clock) or **kept**
(permanent). Free accounts get unlimited drafts and 3 pages kept forever.
Agents publish keylessly and hand the human a claim link. Pro subscriptions fund
the free tier, and the books are public.

A pnpm + Turbo monorepo of two independently deployed apps and one shared
package.

```
kept/
├─ apps/
│  ├─ web/    CONTROL PLANE — Next.js 15 (App Router, RSC, TS). Landing,
│  │          dashboard, auth, publish/manage APIs, Neon Postgres + Drizzle.
│  │          Writes R2 (files) + KV (manifest). Deploys to Railway.
│  └─ edge/   DATA PLANE — Hono Worker on Cloudflare. Serves the wildcard
│             domain from R2 + KV and nothing else. Deploys via Wrangler.
├─ packages/
│  └─ shared/ @kept/shared — types, enums (status/plan/region), constants,
│             zod schemas, KV manifest type. Single source of truth.
├─ docs/      Operational contracts (purge contract, release/rollback runbook).
├─ .github/   CI + the tag-driven deploy workflows.
├─ pnpm-workspace.yaml · turbo.json · package.json · .nvmrc · LICENSE
```

## The one-way serve-path rule (read this first)

Serving is decoupled from the control plane, on purpose:

- `apps/edge` may import `packages/shared`, but **never** `apps/web`.
- Serving **never** calls back to the control plane or the database.
- Communication is one-directional through data stores: `apps/web` **writes**
  R2 (files) + KV (manifest); `apps/edge` only **reads** them.

A control-plane or database outage must not take a hosted page offline. Do not
add a dependency from `apps/edge` to `apps/web` for any reason.

This is verified, not just asserted: E03 stopped the dev control plane and
confirmed pages kept serving through the outage. See
[`docs/rollback-and-release.md`](./docs/rollback-and-release.md).

## Prerequisites

- **Node** — `>= 22`, pinned in [`.nvmrc`](./.nvmrc); run `nvm use` at the repo
  root. This is not advisory: wrangler 4.x will not run on Node 20 at all, so
  `apps/edge` cannot build or test there.
- **pnpm** — `10.13.1` (pinned via `packageManager`). `corepack enable` will
  provision the correct version.

## Install

```bash
corepack enable
nvm use
pnpm install
```

## Common commands (run from the repo root)

Turbo runs each task across every workspace package.

| Command          | What it does                                        |
| ---------------- | --------------------------------------------------- |
| `pnpm dev`       | Run all apps in dev (Next.js + `wrangler dev`).     |
| `pnpm build`     | Build the whole workspace.                          |
| `pnpm typecheck` | `tsc --noEmit` in every package. **This is the type gate** — there is no root `tsconfig.json`, so a bare `pnpm tsc --noEmit` checks nothing. |
| `pnpm lint`      | ESLint across every package.                        |
| `pnpm test`      | Both suites: `@kept/edge` vitest + `@kept/web` Playwright. |
| `pnpm format`    | Prettier write. `pnpm format:check` to verify only. |

Scope to one package with a Turbo filter, e.g.
`pnpm exec turbo run build --filter=@kept/web`.

### Per-app commands

**apps/web** (control plane)

```bash
pnpm --filter @kept/web dev           # next dev (http://localhost:3000)
pnpm --filter @kept/web build         # next build
pnpm --filter @kept/web start         # serve the production build
pnpm --filter @kept/web test          # Playwright e2e (boots its own dev server)
pnpm --filter @kept/web typecheck
pnpm --filter @kept/web lint
pnpm --filter @kept/web db:generate   # drizzle-kit generate (migrations)
pnpm --filter @kept/web db:migrate    # apply migrations
pnpm --filter @kept/web smoke:cf      # R2 + KV write/read smoke test (see below)
pnpm --filter @kept/web smoke:release # post-deploy smoke, used by the pipelines
pnpm --filter @kept/web seed:canary   # (re)seed the edge canary page
```

**apps/edge** (data plane — needs Node 22)

```bash
pnpm --filter @kept/edge dev          # wrangler dev (local Worker)
pnpm --filter @kept/edge build        # wrangler deploy --dry-run (build check)
pnpm --filter @kept/edge test         # vitest on the real Workers runtime
pnpm --filter @kept/edge test:watch
pnpm --filter @kept/edge deploy:dev   # wrangler deploy --env dev
pnpm --filter @kept/edge deploy:prod  # wrangler deploy --env prod
pnpm --filter @kept/edge cf-typegen   # regenerate binding types
pnpm --filter @kept/edge typecheck
pnpm --filter @kept/edge lint
```

> There is deliberately **no** bare `deploy` script. A `wrangler deploy` with no
> `--env` reaches no store by design — every binding lives under `[env.dev]` or
> `[env.prod]`.

## Tests

Two real suites. Neither mocks anything — that is a hard project rule, and it is
what caught a bug where every conditional request 404'd.

- **`apps/edge`** — vitest via `@cloudflare/vitest-pool-workers`, running on the
  actual Workers runtime (workerd) against real local KV, R2 and Cache bindings.
  Covers host→slug resolution, the manifest status matrix, path traversal,
  content types and ETag/304, cache policy, security headers, the KV-miss
  fallback, and store-error handling.
- **`apps/web`** — Playwright e2e. Its `webServer` config boots (or reuses) the
  dev server, so no separate `pnpm dev` is needed.

Run everything with `pnpm test`.

## Environment setup

The repo-root [`.env.example`](./.env.example) is the consolidated, documented
reference for **every** variable across both apps. To run locally:

1. Copy the web vars into `apps/web/.env.local`
   (see [`apps/web/.env.example`](./apps/web/.env.example) for the app-scoped copy).
2. `apps/edge` does **not** use a `.env` file. Non-secret config (R2/KV
   bindings, routes, and the `KEPT_BASE_DOMAIN` / `KEPT_APEX_ORIGIN` vars) lives
   in [`apps/edge/wrangler.toml`](./apps/edge/wrangler.toml); secrets are set
   with `wrangler secret put NAME` or `apps/edge/.dev.vars` (local, gitignored).

`*.env.local`, `.env`, `.dev.vars`, `.agent/`, and `.claude/` are gitignored.
Never commit real secrets — only the placeholder `.env.example` is tracked.

Key variable groups (see `.env.example` for the full set):

- **Neon** — `DATABASE_URL` (pooled, runtime) + `MIGRATION_DATABASE_URL`
  (direct, for `drizzle-kit`).
- **Cloudflare** — R2 S3 credentials, `R2_BUCKET_AUTO` / `R2_BUCKET_EU`,
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `KV_NAMESPACE_ID`.
- **App** — `NEXT_PUBLIC_APP_URL`, `NEXT_TELEMETRY_DISABLED`.
- **CI/deploy** — `RAILWAY_TOKEN`, `RAILWAY_SERVICE_ID`, `NEON_API_KEY`,
  `SMOKE_WEB_URL`, `SMOKE_EDGE_URL`.
- **Reserved but empty** — `BETTER_AUTH_*`, `GITHUB_CLIENT_*`, `RESEND_API_KEY`,
  `EMAIL_FROM`. **E05** fills these in.

`sites.region` defaults to `auto`; the EU bucket is wired but dormant until E11.

## Infrastructure

- **Cloudflare.** Dev and prod are separate Workers, routes, R2 buckets and KV
  namespaces, declared per-environment in `wrangler.toml`. Dev serves
  `*.kept-dev.xyz/*`; prod serves `*.kept.host/*`. (Dev uses its own
  registrable domain because Universal SSL does not cover second-level
  wildcards.) The deploy token needs **Workers Scripts: Edit**, **Workers KV:
  Edit**, **R2** and **Cache Purge** — a missing R2 grant fails at deploy time
  with an opaque `10000 Authentication error`.
- **Neon.** Postgres reachable from `apps/web` via the typed Drizzle client;
  core tables (`profiles`, `sites` incl. `region`, `site_versions`) created via
  `drizzle-kit` migrations. Neon exposes two hostnames for the same database,
  differing by a `-pooler` infix: use the **pooled** URL at runtime
  (`DATABASE_URL`) and the **direct** URL for migrations
  (`MIGRATION_DATABASE_URL`) — DDL and advisory locks fail on the pooler. Prod
  is the Neon root branch; dev is a persistent branch of it.
- **Auth.** Self-hosted Better Auth with its tables in the same database, and
  magic-link email through Resend. Neither is built yet; both land in **E05**
  (a GitHub OAuth app and a Resend key are the external prerequisites).

### Cloudflare smoke test (R2 + KV)

With the web env populated, verify R2 + KV are reachable from the control plane:

```bash
pnpm --filter @kept/web smoke:cf
```

It performs a trivial write/read against R2 and KV and prints PASS/FAIL.

## Deploy

**Merge validates; tags deploy.** `develop` and `main` are protected.

| Trigger                        | Workflow          | Effect                                    |
| ------------------------------ | ----------------- | ----------------------------------------- |
| push / PR to `develop`, `main` | `ci.yml`          | typecheck → lint → build → test. No deploy. |
| `dev-v*` tag (or manual run)   | `deploy-dev.yml`  | validate → migrate → edge → web → smoke, on the `dev` environment. |
| `prod-v*` tag                  | `release.yml`     | same, on `prod`, plus four things dev does not have: a guard that the tag descends from `main`, reviewer approval, a non-skippable Neon backup branch, and a GitHub Release. |

Deploy targets: `apps/web` → **Railway** (two environments, `europe-west4`;
builds from this monorepo). `apps/edge` → **Cloudflare** via Wrangler.

> **Prod has never been deployed.** The prod path is fully built but was
> deliberately not exercised — the prod GitHub Environment currently holds zero
> secrets, and `*.kept.host` DNS/TLS has never been used in anger. Dev is
> deployed and verified end to end. Work through
> [`docs/rollback-and-release.md`](./docs/rollback-and-release.md) before the
> first prod release.

## Docs

- [`docs/rollback-and-release.md`](./docs/rollback-and-release.md) — the release
  and rollback runbook, including a Neon restore procedure corrected against a
  real drill.
- [`docs/edge-purge-contract.md`](./docs/edge-purge-contract.md) — what the
  write path owes the edge: which URLs to purge on publish/replace/rename/
  suspend/delete, and the pointer-write ordering. **Required reading before
  building the publish path (E04).**

## Licence

[AGPL-3.0-only](./LICENSE).
