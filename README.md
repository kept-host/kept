# kept

Anonymous-first page hosting. A pnpm + Turbo monorepo of two independently
deployed apps and one shared package.

```
kept/
├─ apps/
│  ├─ web/    CONTROL PLANE — Next.js 15 (App Router, RSC, TS). Landing,
│  │          dashboard, auth, publish/manage APIs, Supabase + Drizzle.
│  │          Writes R2 (files) + KV (manifest). Deploys to Railway.
│  └─ edge/   DATA PLANE — Hono Worker on Cloudflare. Serves *.kept.host from
│             R2 + KV and nothing else. Deploys via Wrangler.
├─ packages/
│  └─ shared/ @kept/shared — types, enums (status/plan/region), constants,
│             zod schemas, KV manifest type. Single source of truth.
├─ pnpm-workspace.yaml · turbo.json · package.json
```

## The one-way serve-path rule (read this first)

Serving is decoupled from the control plane, on purpose:

- `apps/edge` may import `packages/shared`, but **never** `apps/web`.
- Serving **never** calls back to the control plane or Supabase.
- Communication is one-directional through data stores: `apps/web` **writes**
  R2 (files) + KV (manifest); `apps/edge` only **reads** them.

A control-plane or Supabase outage must not take a hosted page offline. Do not
add a dependency from `apps/edge` to `apps/web` for any reason.

## Prerequisites

- **Node** — `>= 22`. `apps/edge` uses **wrangler 4.x**, which requires Node 22+.
  The rest of the workspace also runs on 22, so use 22 everywhere (CI does).
- **pnpm** — `10.13.1` (pinned via `packageManager`). `corepack enable` will
  provision the correct version.

## Install

```bash
corepack enable
pnpm install
```

## Common commands (run from the repo root)

Turbo runs each task across every workspace package.

| Command           | What it does                                            |
| ----------------- | ------------------------------------------------------- |
| `pnpm dev`        | Run all apps in dev (Next.js + `wrangler dev`).         |
| `pnpm build`      | Build the whole workspace.                              |
| `pnpm typecheck`  | `tsc --noEmit` across every package.                    |
| `pnpm lint`       | ESLint across every package.                            |
| `pnpm format`     | Prettier write. `pnpm format:check` to verify only.     |

Scope to one package with a Turbo filter, e.g.
`pnpm exec turbo run build --filter=@kept/web`.

### Per-app commands

**apps/web** (control plane)

```bash
pnpm --filter @kept/web dev          # next dev (http://localhost:3000)
pnpm --filter @kept/web build        # next build
pnpm --filter @kept/web typecheck
pnpm --filter @kept/web lint
pnpm --filter @kept/web db:generate  # drizzle-kit generate (migrations)
pnpm --filter @kept/web db:migrate   # apply migrations
pnpm --filter @kept/web smoke:cf     # R2 + KV write/read smoke test (see below)
```

**apps/edge** (data plane — needs Node 22)

```bash
pnpm --filter @kept/edge dev         # wrangler dev (local Worker)
pnpm --filter @kept/edge build       # wrangler deploy --dry-run (build check)
pnpm --filter @kept/edge deploy      # wrangler deploy (live; see Deploy)
pnpm --filter @kept/edge typecheck
pnpm --filter @kept/edge lint
```

> There is no test framework wired up in this foundation epic. The only
> runnable verification is the Cloudflare smoke test below.

## Environment setup

The repo-root [`.env.example`](./.env.example) is the consolidated, documented
reference for **every** variable across both apps. To run locally:

1. Copy the web vars into `apps/web/.env.local`
   (see [`apps/web/.env.example`](./apps/web/.env.example) for the app-scoped copy).
2. `apps/edge` does **not** use a `.env` file. Non-secret config (R2/KV
   bindings, routes) lives in [`apps/edge/wrangler.toml`](./apps/edge/wrangler.toml);
   secrets are set with `wrangler secret put NAME` (prod) or `apps/edge/.dev.vars`
   (local, gitignored).

`*.env.local`, `.env`, `.dev.vars`, `.agent/`, and `.claude/` are gitignored.
Never commit real secrets — only the placeholder `.env.example` is tracked.

Key variable groups (see `.env.example` for the full set):
Supabase (URL / anon / service-role), `DATABASE_URL`, Cloudflare R2 S3 creds +
`R2_BUCKET_AUTO` / `R2_BUCKET_EU`, `CLOUDFLARE_API_TOKEN` + `KV_NAMESPACE_ID`,
GitHub OAuth, and `NEXT_PUBLIC_APP_URL`. `sites.region` defaults to `auto`; the
EU bucket is wired but dormant until E8.

## Cloudflare + Supabase provisioning (reproducing the prod track)

- **Cloudflare (task 005):** `kept.host` zone with wildcard DNS `*.kept.host`
  (Universal SSL covers first-level subdomains); one R2 bucket
  (`auto-kept-sites-dev`, default jurisdiction) + a KV namespace
  (`kept-manifest-dev`); S3 credentials for control-plane writes. Bindings are
  declared in `apps/edge/wrangler.toml` (`KEPT_R2`, `KEPT_KV`). The EU-residency
  R2 bucket is added in E8.
- **Supabase (task 006):** Postgres reachable from `apps/web` via the typed
  Drizzle client; core tables (`profiles`, `sites` incl. `region`,
  `site_versions`) created via `drizzle-kit` migrations; the Supabase JS client
  is retained for Auth + Realtime; GitHub OAuth + email magic-link providers
  configured at the project level (flows/UI land in E2).

### Cloudflare smoke test (R2 + KV)

With the web env populated, verify R2 + KV are reachable from the control plane:

```bash
pnpm --filter @kept/web smoke:cf
```

It performs a trivial write/read against R2 and KV and prints PASS/FAIL.

## Deploy

> **CI here is validate-on-merge only.** The full tag-based dev/prod release
> automation (protected branches, environments, promotion) is owned by epic
> **E-CI**. The targets and commands below are the scaffold E-CI builds on.

**apps/web -> Railway** (control-plane host; flagged open question, confirm
before E-CI). Railway builds the Next.js app from this monorepo
(`pnpm install && pnpm --filter @kept/web build`, start `pnpm --filter @kept/web start`).
Deploy automation will use a `RAILWAY_TOKEN` repo/environment secret.

**apps/edge -> Cloudflare (Wrangler).** Deploy the Worker with:

```bash
pnpm --filter @kept/edge deploy        # wrangler deploy
```

This requires a Cloudflare API token with **Workers Scripts: Edit** (provided to
CI as `CLOUDFLARE_API_TOKEN`) and **Node 22**. The Worker serves `*.kept.host/*`
once the route in `wrangler.toml` is enabled (task 005 / E0).

## CI

[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs on push/PR to
`main`: pnpm install (cached) -> `typecheck` -> `lint` -> `build` across the
workspace on Node 22. No deploy step — that is E-CI.
