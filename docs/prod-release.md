# Production Release Runbook

The first production release of kept, end to end, in **closed (waitlist) mode**.
Prod has **never been deployed**: `release.yml` has never run and no prod
resource has served a request. Every prod value below comes from the repo, not
from watching prod run. Check each one as you go.

Companion docs: [`rollback-and-release.md`](./rollback-and-release.md) (rollback,
Neon restore, tags, canary) and [`edge-purge-contract.md`](./edge-purge-contract.md).

> **Secrets rule.** Never paste a secret into this file, a commit, an issue or
> a chat. Values go straight into the Railway dashboard, `gh secret set` (stdin)
> or a password manager. When you run a local command against prod, use a clean
> shell (see §7.1).

---

## 1. Overview

- **What a prod release is:** a PR `develop → main`, merged. Then an annotated
  tag `prod-vX.Y.Z` on a commit on `main`, pushed. The tag triggers
  `.github/workflows/release.yml`. There is no branch trigger and no
  `workflow_dispatch`.
- **Pipeline order:** `guard → validate → backup → migrate → edge → web → smoke → release`.
  `backup` is the first job bound to the `prod` environment, so the run pauses
  there for the required reviewer. GitHub applies that rule **per job**: `backup`,
  `migrate`, `edge`, `web` and `smoke` each wait for their own approval, so a
  release takes **five approvals**.
- **Closed first.** If `NEXT_PUBLIC_KEPT_OPEN` is anything other than `true`
  (unset included), the build is closed:
  - the landing renders and dropping a page opens the waitlist;
  - sign-in is admin-only (`KEPT_ADMIN_EMAILS`);
  - publishing needs an access token or an admin session;
  - every other API answers 404 `not_open`.

  The gate fails closed (`apps/web/lib/launch.ts`).
- **Opening later:** set `NEXT_PUBLIC_KEPT_OPEN=true` on the Railway prod
  service. It is compiled in, so the change only takes effect after a rebuild.
  Railway redeploys on any variable change. See §9.
- **Before any of this:** E06a is merged to `develop` (PR #26). It must be
  verified on dev (`dev-v0.7.0`) before promotion. `develop` is about 190
  commits ahead of `main`; a prod tag only ever deploys what is on `main` (§7.2).

---

## 2. Accounts & plans

- [ ] **Cloudflare**: zone `kept.host` (already on Cloudflare nameservers `bob`/`holly`).
  - **Free plan limit:** Workers KV allows 1,000 writes and 1,000 deletes per
    day per account. That is fine while closed: the smoke does one KV write and
    one delete per release, plus the admin's own publishes.
  - **Upgrade to Workers Paid before opening.** Every publish, rename and
    delete writes KV.
  - If dev and prod share one account, they share the quota. The dev e2e suite
    can exhaust it, after which KV writes fail until 00:00 UTC.
- [ ] **Railway**: the project that holds the dev service.
  - `railway.json` already declares a `prod` environment (`sleepApplication: false`, region `europe-west4`).
  - Needs a plan with custom domains and no sleeping.
- [ ] **Neon**: the existing project. **Prod = the root (default) branch**; dev is a child branch of it.
  - Plan: Launch (history retention 1 day by default, 7 days max; cap of 10 branches).
  - Raise retention to 7 days before the first release.
  - Check the branch count: each release adds one `prerelease-*` branch.
- [ ] **Resend**: domain `kept.host`.
  - The free tier is 100 mails a day, shared by magic links, waitlist
    confirmations and reminders. The app's global cap is 300 confirmations an
    hour, so plan a paid tier before the waitlist is promoted publicly.
- [ ] **GitHub**: repo `kept-host/kept` (public).
  - `main` and `develop` are protected. `main` requires `Typecheck / Lint / Build / Test`
    and `Main PR source` (`main-pr-source.yml`: a PR into `main` must come from `develop`).
  - The default branch is `develop` until launch, then `main` (§8, Crons).
  - The `prod` environment exists with **required reviewers** and a deployment
    policy limited to branch `main` and tags `prod-v*`. Nothing to add there.
- [ ] **Google Cloud** (OAuth client) and **GitHub OAuth app**: new prod ones (§3.6).

---

## 3. Infrastructure to create (prod)

### 3.1 Cloudflare DNS: zone `kept.host`

Public DNS observed on 2026-10-11:
- A proxied wildcard `*` exists: `app.`, `www.`, `smoke.` and random labels all
  resolve to Cloudflare and currently answer **522**.
- The apex has **no A/CNAME**.
- `resend._domainkey` (DKIM), `send` MX and SPF exist. **`_dmarc` is missing.**
- The root MX points at `inbound-smtp.eu-west-1.amazonaws.com`.

| Record | Type / target | Proxy | Why |
|---|---|---|---|
| `kept.host` (apex) | CNAME (flattened) → Railway target for the prod service | **Proxied** (orange) | Landing; mirrors `kept-dev.xyz` |
| `app.kept.host` | CNAME → Railway target for the **same** prod service | **DNS-only (grey)** | Control plane. Grey takes it out of the Worker route `*.kept.host/*`. Orange makes the Worker treat it as a slug and serve the branded 404. This is the most likely mistake. |
| `*.kept.host` | keep the existing proxied wildcard | Proxied | Worker route `*.kept.host/*` only fires on proxied traffic |
| `_dmarc.kept.host` | TXT `v=DMARC1; p=none; rua=mailto:<you>` (tighten later) | DNS-only | DMARC is missing today |
| Railway verification TXT records | as Railway shows them | DNS-only | Custom-domain verification |

- [ ] An explicit `app` record overrides the wildcard. Confirm it is grey.
- [ ] Copy the SSL/TLS mode from `kept-dev.xyz` (the proxied apex → Railway works there today).
- [ ] Universal SSL covers `kept.host` and `*.kept.host`. Nothing deeper is used.

### 3.2 Cloudflare Worker, R2, KV

From `apps/edge/wrangler.toml` `[env.prod]`:

| Thing | Prod value | Status |
|---|---|---|
| Worker name | `kept-edge-prod` | created by the first `wrangler deploy --env prod` |
| Route | `*.kept.host/*` (zone `kept.host`) | created by the deploy |
| R2 bucket (`KEPT_R2`) | `auto-kept-sites` | provisioned in E02 task 002 (no `-prod` suffix); confirm before tagging |
| KV namespace (`KEPT_KV`) | id `9a7b60ede13646079c3750276f4864be` (`kept-manifest`) | the id is committed; **unverified** that it exists in the prod account |
| Vars | `KEPT_BASE_DOMAIN=kept.host`, `KEPT_APEX_ORIGIN=https://kept.host` | in `wrangler.toml` |
| Worker secrets | **none** | Worker reads R2 + KV only |

- [ ] `wrangler r2 bucket list` / `wrangler kv namespace list` (Node 22, prod token) and confirm both.
  - **The prod bucket is `auto-kept-sites`.** Only dev carries a suffix
    (`auto-kept-sites-dev`). E02 task 002 provisioned the prod resources unsuffixed;
    the `auto-kept-sites-prod` in the E02 PRD was a guess that never existed.
  - The bucket the Worker binds and `R2_BUCKET_AUTO` on Railway/GitHub **must be the same**.
- [ ] Optional: create `eu-kept-sites` (unbound until EU residency; the app never reads `R2_BUCKET_EU`).
- [ ] R2 S3 API token: **Object Read & Write** on the prod bucket(s) only. This gives `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`.
- [ ] Cloudflare API token, prod only, fenced to account + zone `kept.host`, with:
  - Workers Scripts: Edit
  - Workers KV Storage: Edit
  - Workers R2 Storage: Edit (missing → opaque `10000 Authentication error` at deploy)
  - Zone → Cache Purge
  - Zone → Analytics → Read (visits sync)
  - Zone → Workers Routes: Edit

  The deploy and the app can share one token, as on dev, or use two narrower tokens.
- [ ] `CLOUDFLARE_ZONE_ID` = the `kept.host` zone's ID (Overview → API).

### 3.3 Turnstile

- [ ] Create a Managed widget with hostnames `kept.host` and `app.kept.host`.
  - The waitlist, founding and email forms render on the apex; the publish route also verifies.
  - This gives `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (public) and `TURNSTILE_SECRET_KEY` (secret).
  - With no keys, `verifyTurnstile` fails closed and every form refuses.
- [ ] Separate widgets for `kept-dev.xyz` and `localhost`. Those are dev items, not prod blockers.

### 3.4 Railway

- [ ] In the `prod` environment, create the web service from this repo.
  - `railway.json` supplies the build (`pnpm turbo run build --filter=@kept/web`), the start command and the healthcheck `/api/health`.
- [ ] Custom domains on **that one service**: `kept.host` **and** `app.kept.host`.
  - Not two services. Check that both hostnames serve the same build.
- [ ] An environment-scoped **project token** for `prod` → `RAILWAY_TOKEN`. The service's ID → `RAILWAY_SERVICE_ID`.
- [ ] Set every variable in §4.1 **before** the first deploy.

### 3.5 Neon

- [ ] On the **root branch**, copy two connection strings:
  - **pooled** (`-pooler`) → `DATABASE_URL`, used by Railway and the smoke;
  - **direct** (no `-pooler`) → `MIGRATION_DATABASE_URL`. DDL and advisory locks fail on the pooler.
- [ ] Neon API key → `NEON_API_KEY`. Project ID → `NEON_PROJECT_ID` (optional; required if the account has more than one project).
- [ ] Check which migrations, if any, the root branch already has (§6).

### 3.6 Resend

- [ ] `kept.host` is verified in Resend: DKIM ✓ and SPF ✓ are in DNS; **add DMARC** (§3.1).
- [ ] Create a **sending-only** API key for prod → `RESEND_API_KEY`. `EMAIL_FROM`, e.g. `kept <page@kept.host>`.
- [ ] Turn open and click tracking **off** on the domain, then prove it with a full-access key (§5).

### 3.7 OAuth apps (prod)

Better Auth callback paths are `{BETTER_AUTH_URL}/api/auth/callback/{provider}`
(`apps/web/.env.example`). Register them **before** setting the Railway env, or
sign-in fails with an opaque provider error.

- [ ] **GitHub OAuth app** (prod):
  - homepage `https://kept.host`
  - callback `https://app.kept.host/api/auth/callback/github`
  - gives `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
- [ ] **Google OAuth client** (Web, prod):
  - authorized redirect URI `https://app.kept.host/api/auth/callback/google`
  - JS origin `https://app.kept.host`
  - scopes `openid email profile`
  - gives `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- [ ] Magic links need no registration. They verify on `app.kept.host` via Resend.

---

## 4. Environment & secrets

The ✅/❌ columns are GitHub **names only**, from `gh secret list --env prod`,
`gh variable list --env prod` and the repo-level lists on 2026-10-11. The prod
environment holds **0 secrets and 1 variable** (`SMOKE_EDGE_URL=https://smoke.kept.host`).
There are no repo-level secrets or variables. `openssl rand -base64 32` means
"32+ random bytes; generate a fresh value per track, never reuse dev's".

### 4.1 Railway: prod web service variables

All of these are read by `apps/web` at runtime or build time
(`lib/storage/env.ts`, `.env.example`).

| Name | Secret | Value / how to get it |
|---|---|---|
| `DATABASE_URL` | yes | Neon root branch, **pooled** |
| `R2_ACCOUNT_ID` | no | Cloudflare account ID (shared by R2 and KV) |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | yes | R2 S3 token (§3.2) |
| `R2_BUCKET_AUTO` | no | `auto-kept-sites` (must match `wrangler.toml`) |
| `CLOUDFLARE_API_TOKEN` | yes | prod token (KV edit, Cache Purge, Analytics Read) |
| `KV_NAMESPACE_ID` | no | `9a7b60ede13646079c3750276f4864be` (confirm) |
| `CLOUDFLARE_ZONE_ID` | no | `kept.host` zone ID |
| `KEPT_BASE_DOMAIN` | no | `kept.host` (bare; **not** `app.`) |
| `NEXT_PUBLIC_APP_URL` | no | `https://app.kept.host` |
| `BETTER_AUTH_URL` | no | `https://app.kept.host` (identical to the above) |
| `BETTER_AUTH_SECRET` | yes | `openssl rand -base64 32` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | id no / secret yes | §3.7 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | id no / secret yes | §3.7 |
| `RESEND_API_KEY` | yes | sending-only prod key |
| `EMAIL_FROM` | no | `kept <page@kept.host>` |
| `CRON_SECRET` | yes | `openssl rand -base64 32`. **Required even while closed**: the smoke expects 401 from `/api/cron/draft-reminder`, and an unset secret throws |
| `PUBLISHER_HASH_SALT` | yes | `openssl rand -base64 32` |
| `KEPT_ADMIN_EMAILS` | no (PII) | Comma-separated admin addresses. Use the address Google/GitHub actually return; GitHub's no-reply address never matches |
| `KEPT_ACCESS_TOKEN_HASHES` | no (digests) | `pnpm --filter @kept/web admin:token new` prints the token once on stdout. Keep it in a password manager and put **only the SHA-256** here (comma-separated). No DB needed |
| `KEPT_ADMIN_SECRET` | yes | `openssl rand -base64 32` (HMAC for founding review and unsubscribe links) |
| `RATE_LIMIT_SECRET` | yes | `openssl rand -base64 32` |
| `TURNSTILE_SECRET_KEY` | yes | §3.3 |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | no | §3.3 |
| `NEXT_PUBLIC_KEPT_OPEN` | no | **unset** (or `false`) for pre-launch. `true` only on launch day |
| `NEXT_TELEMETRY_DISABLED` | no | `1` |
| `NEXT_PUBLIC_LOCKED_CTA_URL` | no | leave unset (E11) |

Not set on Railway: `MIGRATION_DATABASE_URL` (CI only), `R2_BUCKET_EU` (unread).

### 4.2 GitHub `prod` environment: secrets

| Name | Used by | What | Present |
|---|---|---|---|
| `NEON_API_KEY` | `backup` | Neon API key | ❌ |
| `MIGRATION_DATABASE_URL` | `migrate` | root branch, **direct** | ❌ |
| `CLOUDFLARE_API_TOKEN` | `edge`, `smoke` | prod token | ❌ |
| `CLOUDFLARE_ACCOUNT_ID` | `edge`, `smoke` (as `R2_ACCOUNT_ID`) | account ID | ❌ |
| `RAILWAY_TOKEN` | `web` | prod-environment project token | ❌ |
| `RAILWAY_SERVICE_ID` | `web` | prod service ID | ❌ |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | `smoke` | R2 S3 token | ❌ / ❌ |
| `DATABASE_URL` | `smoke` | root branch, **pooled** | ❌ |

`CRON_SECRET` does **not** go here. The prod crons use their own environment,
`prod-cron` (§4.5), because a cron job bound to `prod` would wait for the
required reviewer every day.

```bash
gh secret set NEON_API_KEY --env prod      # paste on stdin; never as an argument
```

### 4.3 GitHub `prod` environment: variables

| Name | Value | Present |
|---|---|---|
| `SMOKE_EDGE_URL` | `https://smoke.kept.host` (canary slug `smoke`) | ✅ |
| `SMOKE_WEB_URL` | `https://app.kept.host` (the `app.` origin, not the apex) | ❌ |
| `R2_BUCKET_AUTO` | `auto-kept-sites` | ❌ |
| `KV_NAMESPACE_ID` | `9a7b60ede13646079c3750276f4864be` | ❌ |
| `NEON_PROJECT_ID` | Neon project ID (optional, see §3.5) | ❌ |

`SMOKE_LEGAL_PLACEHOLDERS` is **not** a variable. `release.yml` hard-codes
`fail`; `deploy-dev.yml` hard-codes `warn`.

### 4.4 GitHub repository variables: cron switches

Each cron workflow has one job per track, and each track's **scheduled** run
has its own switch. They are repository variables because a job-level `if:` is
decided before the job enters an environment, so it cannot read environment
variables. A switched-off schedule is skipped (grey), not red. A manual
dispatch (`target: dev | prod`) always runs the chosen track.

| Name | Track | Turns on | Set to `true` when | Present |
|---|---|---|---|---|
| `REPURGE_ENABLED` | dev | `cron-repurge.yml` | proven on dev | ✅ `true` (2026-10-20) |
| `EXPIRE_ENABLED` | dev | `cron-expire.yml` | proven on dev (1 KV write per expired draft) | ✅ `true` (2026-10-20) |
| `PURGE_ENABLED` | dev | `cron-purge.yml` | proven on dev (1 KV delete per purged page; it deletes for good) | ✅ `false` (2026-10-20) |
| `SCAN_RETRY_ENABLED` | dev | `cron-scan-retry.yml` | dev Railway has `OPENROUTER_API_KEY` | ✅ `false` (2026-10-20) |
| `DRAFT_REMINDER_ENABLED` | dev | `cron-draft-reminder.yml` | you want dev reminders mailed (Resend quota) | ❌ (unset = off) |
| `VISITS_SYNC_ENABLED` | dev | `cron-visits-sync.yml` | dev token has Zone → Analytics → Read | ❌ |
| `WAITLIST_PRUNE_ENABLED` | dev | `cron-waitlist-prune.yml` | dev Resend tracking is off | ❌ |
| `PROD_DRAFT_REMINDER_ENABLED` | prod | `cron-draft-reminder.yml` | prod is deployed and `prod-cron` is set (§4.5) | ❌ |
| `PROD_VISITS_SYNC_ENABLED` | prod | `cron-visits-sync.yml` | prod token has Analytics Read | ❌ |
| `PROD_REPURGE_ENABLED` | prod | `cron-repurge.yml` | prod is deployed and `prod-cron` is set (§4.5) | ❌ |
| `PROD_EXPIRE_ENABLED` | prod | `cron-expire.yml` | prod is deployed and `prod-cron` is set | ❌ |
| `PROD_PURGE_ENABLED` | prod | `cron-purge.yml` | prod is deployed and `prod-cron` is set | ❌ |
| `PROD_SCAN_RETRY_ENABLED` | prod | `cron-scan-retry.yml` | prod Railway has `OPENROUTER_API_KEY` | ❌ |
| `PROD_WAITLIST_PRUNE_ENABLED` | prod | `cron-waitlist-prune.yml` | prod Resend tracking check passed (§5) | ❌ |

Every job has a switch, the dev draft reminder included. Once a dev cron is
proven, its dev switch can stay off; dispatch it by hand when testing.

**Scheduled runs fire only from the default branch's workflow files.** The
branch decides a cron's *definition* (schedule, route, whether a prod job
exists); the job's environment decides its *target* (`dev` → app.kept-dev.xyz,
`prod-cron` → app.kept.host). Until launch the default branch is `develop`, so
the dev schedules run from `develop`. At launch the default becomes `main`
(§8), so prod cron definitions change only with a release.

```bash
gh variable set PROD_WAITLIST_PRUNE_ENABLED --body true   # repo-level, not --env
```

### 4.5 GitHub `prod-cron` environment

Every cron workflow calls `.github/workflows/cron-post.yml`, which binds the
track's environment: `dev`, or `prod-cron` for prod. `prod-cron` holds only what
a cron call needs, with **no** required reviewer.

- [ ] Create it (Settings → Environments → New), or let the first prod cron run
  create it. Either way, set **Deployment branches and tags → Selected → `main`**
  so no other branch can reach the prod `CRON_SECRET`. This is why the default
  branch must be `main` before any `PROD_*_ENABLED` switch is on: scheduled runs
  use the default branch, and a `develop` run cannot enter `prod-cron`. Manual
  prod dispatches need `--ref main` (`gh workflow run cron-repurge.yml --ref main -f target=prod`).

| Name | Kind | Value | Present |
|---|---|---|---|
| `CRON_SECRET` | secret | same value as Railway prod `CRON_SECRET` | ❌ (environment does not exist yet) |
| `SMOKE_WEB_URL` | variable | `https://app.kept.host` | ❌ |

Then dispatch each workflow once with `target: prod` (visits with `days=30`)
before turning on its `PROD_*` switch.

### 4.6 Worker (`apps/edge`)

No secrets. The vars `KEPT_BASE_DOMAIN` and `KEPT_APEX_ORIGIN` are committed in
`wrangler.toml`. Nothing to set.

---

## 5. Legal & compliance gates

- [ ] **Legal placeholders.** Fill every `[[…]]` in
  `apps/web/content/legal/impressum.md` and `privacy.md`:
  - full name, street, postcode, city, email, phone, VAT ID (or delete that line).

  **In the same commit**, update both pinned digests in `DELIVERED_SHA256`
  (`apps/web/lib/legal/legal.test.ts`). The test logs the new `sha256=` on
  failure. The release smoke **fails** while any `[[` remains (AC19).
  - [ ] Check: `rtk proxy grep -n '\[\[' apps/web/content/legal/*.md` returns nothing.
  - [ ] Review both texts before the public launch.
- [ ] **DPAs:**
  - Cloudflare, Neon and Resend come through their ToS/DPA pages (record the date accepted).
  - **Railway is not automatic.** Request it and sign via DocuSign.
- [ ] **Resend tracking off.** With a **full-access** key, set in the command only:
  ```bash
  RESEND_API_KEY=<full-access key> EMAIL_FROM='kept <page@kept.host>' \
    pnpm --filter @kept/web resend:tracking
  ```
  Both flags must print `false` (exit 0). The prod app key stays sending-only;
  it gets `restricted_api_key` here, which is expected. **Then** set
  `WAITLIST_PRUNE_ENABLED=true`.
- [ ] **DMARC** record added (§3.1); SPF/DKIM show verified in Resend.
- [ ] **Go-live day:**
  - file the PSL request for `kept.host` (E07 owns it; defence in depth since E05a);
  - add `kept.host/impressum` (308 → `/legal/impressum`) to every social profile.

---

## 6. Database

- `release.yml` `backup` runs `neonctl branches create --name prerelease-<tag>` off the root branch. It is not skippable.
- Then `migrate` runs `pnpm --filter @kept/web db:migrate` (`drizzle-kit migrate`, forward-only) against `MIGRATION_DATABASE_URL`.
- **First run:** applies `0000`–`0007` (journal has 8 entries) to the root branch. All 8 were verified to apply from empty on 2026-10-11.
- Prod may hold `0000` from E00. `drizzle-kit` skips what its journal table already records.

- [ ] Before tagging, take a manual snapshot as well: `neonctl branches create --name pre-first-release --project-id <id>`. It counts against the 10-branch cap.
- [ ] Retention raised to 7 days.
- [ ] Branch count ≤ 8 (backup + spare).
- [ ] After the release, `prerelease-prod-v0.1.0` stays. Follow the retention policy in `rollback-and-release.md` §5.

---

## 7. Release procedure

### 7.1 One-time pre-flight (local, Node 22)

- [ ] `nvm use` at the repo root.
- [ ] **Seed the prod canary.** Without it the smoke's edge check 404s. Run it
  after the Worker exists, or re-run the release afterwards.
  - The script loads `apps/web/.env.local` (**dev** values) with dotenv, which
    only fills variables that are **unset**. A forgotten prod variable silently
    falls back to dev. Run from a **clean shell**, with **every** variable it
    reads exported to prod values:
    `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_AUTO`,
    `KV_NAMESPACE_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `KEPT_BASE_DOMAIN`.
  ```bash
  pnpm --filter @kept/web seed:canary --edge-url https://smoke.kept.host
  ```
  - Order: §7.2 → the release fails at `smoke` (canary 404) → seed → re-run
    the failed `smoke` job. Or deploy the Worker by hand first with
    `pnpm --filter @kept/edge deploy:prod` and the prod token. Either works.
    Seeding only needs R2 + KV, not the Worker, so you can also **seed before
    tagging**. That is the simplest order.
- [ ] Optional: run the same clean shell with `pnpm --filter @kept/web smoke:cf` to prove R2 + KV credentials.

### 7.2 Cut the release

1. [ ] E06a merged to `develop`, `dev-v0.7.0` deployed and green; legal placeholders committed (§5).
2. [ ] **Promote `develop` → `main`.** Open the PR:
   `gh pr create --base main --head develop --title "release: prod-v0.1.0"`.
   CI must pass. Merge with **"Create a merge commit"**, not squash, so `main`
   keeps `develop`'s history (and the next promotion has a merge base). Never
   tag `develop`: `guard` fails any `prod-v*` tag not reachable from `origin/main`.
3. [ ] Tag the merge commit on `main`:
   ```bash
   git fetch origin
   SHA=$(git rev-parse origin/main)
   git merge-base --is-ancestor "$SHA" origin/main && echo OK   # what `guard` runs
   git tag -a prod-v0.1.0 "$SHA" -m "prod-v0.1.0: first prod release (closed)"
   git push origin prod-v0.1.0
   ```
4. [ ] Watch `gh run watch` (workflow **Release**):

   | Job | Expect |
   |---|---|
   | `guard` | tag reachable from `origin/main` |
   | `validate` | typecheck, lint, build, unit + e2e (auth/live specs skip with no secrets) |
   | `backup` | **pauses for reviewer approval** (`prod` env). Approve, then `prerelease-prod-v0.1.0` is created. `migrate`, `edge`, `web` and `smoke` each pause for approval too |
   | `migrate` | `0000`–`0007` applied to the root branch |
   | `edge` | `wrangler deploy --env prod` creates `kept-edge-prod` + route `*.kept.host/*` |
   | `web` | `railway up` to the prod service, polled to SUCCESS (≤ 20 min) |
   | `smoke` | see below |
   | `release` | GitHub Release `prod-v0.1.0` with generated notes |

5. [ ] **Smoke expectations (closed mode)** (`smoke-release.ts`):
   - `/api/health` → 200 `{status:"ok", open:false}`
   - R2 put/get/delete and KV put/get/delete pass; Neon reachable via the pooled URL
   - canary `https://smoke.kept.host/` → 200, exact bytes, `ETag`, 304 on revalidate
   - `POST /api/publish` with no token, and with a well-formed unknown token → **404 `not_open`**, no site row created
   - `GET /api/auth/get-session` with no cookie → no session and **no `Set-Cookie`**
   - `/api/cron/draft-reminder` without the secret → **401**, not 404
   - `/legal/impressum` and `/legal/privacy` → 200. **Any `[[` → FAIL** (prod policy `fail`)

   On failure: fix forward and re-cut (`rollback-and-release.md` §6). A red
   `web` does not take `*.kept.host` down.

---

## 8. Post-deploy verification

- [ ] `https://kept.host/` shows the landing; the drop zone opens the waitlist dialog; no counters (closed).
- [ ] `https://app.kept.host/api/health` → `"open":false`. `https://kept.host/dashboard` → 307 to `app.`, then admin-only.
- [ ] `https://www.kept.host/` → 301 to `https://kept.host`. A random `https://zzz-test.kept.host/` → branded 404 from the Worker.
- [ ] `app.kept.host` is grey-clouded: response headers have no `cf-ray`, and the build ID matches the apex.
- [ ] **Admin sign-in** at `https://app.kept.host/auth` with an allowlisted email:
  - GitHub ✓, Google ✓, magic link ✓;
  - a non-allowlisted account → `/auth?error=not_open`.
- [ ] **Access token:** `POST https://app.kept.host/api/publish` with `Authorization: Bearer kpt_access_…` publishes; the page serves at `{slug}.kept.host`; delete it.
- [ ] **Waitlist double opt-in, real inbox:**
  - join on the apex (Turnstile passes) → confirmation mail arrives;
  - the mail shows Impressum and Privacy footer links and a one-click unsubscribe;
  - the link confirms at `/waitlist/confirm`;
  - `DATABASE_URL=<prod pooled> pnpm --filter @kept/web admin:waitlist stats` (clean shell; it prints the `database:` label, so check it) shows the row confirmed;
  - unsubscribe works.
- [ ] **Founding:**
  - apply at `/founding` → every `KEPT_ADMIN_EMAILS` address gets the review mail;
  - its `/founding/review` link approves → the applicant gets the approval mail.
- [ ] **Legal:** `/legal/impressum`, `/legal/privacy`, and `/impressum` (308). No DRAFT banner.
- [ ] **Previews:** `/og.png`, `/founding/og.png`, `/favicon.ico`, `/icon.svg`, `/apple-touch-icon.png` → 200. Paste `https://kept.host` into a link-preview debugger.
- [ ] **Serve independence (optional):** with the control plane stopped, the canary still serves (`rollback-and-release.md` §8; dev drill only, so do not stop prod casually).
- [ ] **Crons (prod track).** Switch the default branch to `main` (Settings → General → Default branch;
  `main` now holds the cron workflows after the promotion). Set up `prod-cron` (§4.5), then dispatch
  each by hand from `main` with `target: prod`:
  - `cron-repurge.yml`, `cron-expire.yml`, `cron-purge.yml` → HTTP 200 with counts;
  - `cron-scan-retry.yml` → HTTP 200 with counts, once prod has `OPENROUTER_API_KEY`;
  - `cron-draft-reminder.yml` → HTTP 200 with counts;
  - `cron-waitlist-prune.yml` → `{ deleted }`, after the Resend tracking check (§5);
  - `cron-visits-sync.yml` with `days=30`, once the prod token has Analytics Read.
  - Green by hand → set that job's `PROD_*_ENABLED` switch (§4.4).

---

## 9. Opening (launch day) and rollback

- [ ] Cloudflare on **Workers Paid** (KV quota).
- [ ] Resend plan can carry launch volume.
- [ ] E07 shipped: abuse pipeline, expiry/purge crons, PSL filed. Launch requires E06–E14.
- [ ] Prod cron jobs dispatched green and their `PROD_*_ENABLED` switches on (§8).
- [ ] Set `NEXT_PUBLIC_KEPT_OPEN=true` on the Railway prod service. Railway rebuilds.
  - A variable flip is not a tag. It bypasses `release.yml`, so run the smoke by hand afterwards:
    `SMOKE_WEB_URL=https://app.kept.host SMOKE_EDGE_URL=https://smoke.kept.host pnpm --filter @kept/web smoke:release`
    (prod store vars exported, clean shell).
  - It now runs the **open** path: publish → serve → delete.
- [ ] `/api/health` → `"open":true`. An anonymous publish works. Sign-in is open to all.
- [ ] Decide what to do with `KEPT_ACCESS_TOKEN_HASHES`. Tokens stay valid after opening; remove the digests you no longer want.
- [ ] Post the Impressum link; file the PSL request (§5).

**Rollback:**
- Close again: unset `NEXT_PUBLIC_KEPT_OPEN` (rebuild).
- Worker: `wrangler rollback`.
- Railway: dashboard rollback.
- DB: `neonctl branches restore … --preserve-under-name`.

All in [`rollback-and-release.md`](./rollback-and-release.md). Nothing rolls back
automatically.

---

## 10. Open items and unknowns

Not verifiable from the repo or from public DNS on 2026-10-11:

- **R2 bucket and KV namespace existence** in the prod Cloudflare account. `wrangler` needs a token not available here. E02 task 002 records both as provisioned (`auto-kept-sites`, `kept-manifest`); not re-checked since.
- **Whether prod and dev share a Cloudflare account**, and with it the KV free quota.
- **Railway prod service / environment state.** It is unknown whether the `prod` environment or a service exists; the root-domain SSL mode needs copying from dev.
- **Neon root branch state**: its name, whether `0000` was ever applied, and the current branch count against the cap of 10.
- **Resend:** whether dev and prod share the `kept.host` domain and account; tracking flags unknown. The root MX (`inbound-smtp.eu-west-1.amazonaws.com`) looks like Resend inbound; confirm it is intended.
- **The canary seed's dotenv fallback** to `.env.local` can silently mix dev values into a prod run. Mitigated only by procedure (§7.1).
- **Turnstile subdomain coverage:** list `app.kept.host` explicitly rather than rely on parent-hostname matching.
- **Dev Neon password rotation** is still pending from before E06a.
