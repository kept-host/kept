# Rollback & Release Runbook

Operator procedures for unwinding a bad deploy on either track. Verified against
`neonctl` 2.x, `wrangler` 4.104, `@railway/cli` 4.x on 2026-08-03.

Secret **values** never appear here. Names refer to the GitHub Environment
keys defined in E02 task 004 (`dev` / `prod` environments).

## 1. Which surface is broken?

| Symptom                                                     | Surface             | Go to                                  |
| ----------------------------------------------------------- | ------------------- | -------------------------------------- |
| `{slug}.kept.host` serves wrong/stale HTML, or 500s         | Worker              | [§3](#3-worker-apps-edge)              |
| `{slug}.kept.host` 404s for a page that should exist        | KV/R2 data          | [§5](#5-database--stores)              |
| Dashboard / publish / auth broken; pages still serve        | Control plane       | [§4](#4-control-plane-apps-web)        |
| Control plane 500s right after a release, DB errors in logs | Database            | [§5](#5-database--stores)              |
| Release run failed at `guard`                               | Tagging             | [§6](#6-tags-and-re-cutting-a-release) |
| Release run failed at `web`, everything else green          | **Usually nothing** | [§2](#2-ordering-and-why-it-matters)   |

**First question, always: is serving actually down?** `apps/edge` reads only KV
and R2. It does not call the control plane or the database. A broken dashboard is
not a serving outage and must not be treated as one.

## 2. Ordering, and why it matters

Deploy order is `backup → migrate → edge → web`. **Rollback runs in reverse:
`web → edge → migrate`.**

The reason is asymmetric coupling. **`apps/edge` is schema-agnostic** — it never
touches Postgres, so any Worker version is safe against any schema; that is why it
deploys early and is almost never what you roll back. **`apps/web` is the
schema-coupled surface** — the only thing that breaks when code and schema
disagree, so it deploys last and rolls back first.

Two consequences:

- **A failed `web` job is not an outage.** `edge` already deployed, serving is
  live. The correct response is nearly always **roll forward the control plane**,
  not roll back the Worker. Rolling back the Worker here fixes nothing and
  changes the serve path for no reason.
- **Rolling back the Worker _after_ a successful web deploy is the dangerous
  case.** You would be pairing an old Worker with a new schema and a new control
  plane. Only do it if serving itself is provably broken, and expect to roll back
  `web` too.

## 3. Worker (`apps/edge`)

`--env` is **mandatory** — task 002 removed all top-level bindings, so a bare
`wrangler deploy` cannot reach a store. Same for the rollback commands.

```bash
# What is live, and what can I go back to?
pnpm --filter @kept/edge exec wrangler deployments list --env dev
pnpm --filter @kept/edge exec wrangler versions list --env dev

# Roll back. Omit the version-id to take the version before the latest.
pnpm --filter @kept/edge exec wrangler rollback <version-id> \
  --env dev --yes --message "why you are doing this"
```

Swap `--env dev` for `--env prod` on the prod track. Requires
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.

**Verified behaviour** (drilled on dev, 2026-08-03):

- A rollback creates a **new deployment pointing at the old version**. It does
  not delete the newer version — roll forward by rolling back _to_ it.
- Only the **100 most recent versions** are reachable.
- **Rollback does not touch bound resources.** Wrangler prints this explicitly:
  R2 objects and KV keys written by the newer version stay written. If the bug
  corrupted the KV manifest, the rollback will not fix it — see §5.
- Rollback is refused if the target version binds an R2 bucket, KV namespace, or
  queue that no longer exists, or across a Durable Object class lifecycle change.
- **`wrangler versions rollback` does not exist.** It silently prints the
  `wrangler versions` help and **exits 0** — a script using it would report a
  successful rollback that never happened. Only `wrangler rollback` is real.

## 4. Control plane (`apps/web`)

Railway. Note the CLI's limit up front: **`railway redeploy` only redeploys the
_latest_ deployment.** There is no CLI flag to target a specific older one.

```bash
railway deployment list -s <service> -e <environment> --limit 20 --json
railway redeploy -s <service> -e <environment> -y   # latest only
```

To go back to a **specific prior deployment**, use the dashboard
(Service → Deployments → ⋯ → Rollback) or the GraphQL API directly:

```bash
curl -sS -X POST https://backboard.railway.com/graphql/v2 \
  -H "Project-Access-Token: $RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"mutation { deploymentRollback(id: \"<deployment-id>\") { id status } }"}'
```

Railway restores both the image and the variables. Deployments past the plan's
retention window cannot be rolled back. Check `canRedeploy` on a deployment node
before relying on it.

**The Serverless wrinkle — do not misread it.** The dev service sleeps. Railway
documents that the **first request to a slept service may return 502** while it
wakes. A 502 immediately after a rollback is very likely a cold start, **not a
failed rollback.** Retry with backoff (`smoke:release` already does) before
concluding anything. Prod does not run Serverless, so a 502 there is real.

## 5. Database & stores

### Policy — read this before touching anything

- **Migrations are forward-only.** A bad migration is fixed by writing a **new
  forward migration**, not by reversing the old one.
- **`drizzle-kit` down-migrations are not part of this pipeline.** They are not
  generated, not committed, and not runnable here. Do not go looking for them.
- **Destructive schema changes use expand-contract**: add the new shape, migrate
  reads/writes, then drop the old shape in a later release.
- Branch restore is the **disaster** path — data loss or a migration that
  corrupted rows. It is not the routine fix for a bad deploy.

### Restoring prod from the pre-release backup branch

`release.yml` creates `prerelease-$TAG` off the default branch before any DDL
runs. It is not skippable, so it is always there for a release that got as far as
`migrate`.

```bash
export NEON_API_KEY=...            # prod-path credential; not on dev machines
npx neonctl branches list --project-id <project-id>

# Restore the prod branch from the backup taken before this release.
npx neonctl branches restore <prod-branch> prerelease-<tag> \
  --preserve-under-name prod_pre_rollback
```

Neon **automatically preserves the target's pre-restore state** as a new branch;
`--preserve-under-name` only names it. Connection strings do not change, so no
secret rotation is needed — but **open connections are briefly interrupted**, so
restart the Railway service afterwards. Point-in-time works too
(`<source>@2026-08-03T10:00:00Z`), bounded by the history window below.

### Re-syncing a drifted dev branch

```bash
npx neonctl branches reset dev --parent --preserve-under-name dev_before_reset
```

**Destructive and deliberately not automated in any workflow.** It overwrites
every database on `dev` with the parent's current head — a complete overwrite,
not a merge, and not point-in-time. Human-run only, and `deploy-dev.yml` says so
in a comment. Never add it to CI: a data-loss button with no confirmation.

### Retention and branch budget — decide before an incident, not during

Neon **Launch**: history retention is **1 day by default, 7 days maximum**, and
the project is capped at **10 branches**. Two consequences:

- Point-in-time restore beyond the retention window is impossible. Raise
  retention toward 7 days before a risky release; it is a project setting.
- **`prerelease-*` branches and auto-preserved restore backups both count
  against the 10-branch cap.** Releases will start failing at `backup` once the
  cap is hit — during a release, which is the worst time to discover it.

**Policy: keep the `prerelease-*` branches for the last 3 releases. Delete older
ones manually once the release has been stable for a week.**

```bash
npx neonctl branches delete prerelease-<old-tag> --project-id <project-id>
```

Note `branches delete` has **no `--force`/`--yes`** flag. Do not script it blind.

### KV and R2

Neither is versioned and neither is covered by a Worker rollback. There is no
snapshot to restore. If a release corrupted the KV manifest, the fix is to
rewrite the affected keys from Postgres via the control plane. Because R2 is keyed
`sites/{siteId}/{versionId}/index.html`, old versions are still present and a
manifest repair is usually enough.

## 6. Tags and re-cutting a release

A `prod-v*` tag whose commit is not reachable from `main` **fails at the guard**
and deploys nothing. That is correct behaviour.

**Never "fix" the guard.** Delete the tag and re-cut it from `main`:

```bash
git tag -d prod-v1.2.3
git push origin :refs/tags/prod-v1.2.3     # delete remote tag
# merge the work into main first, then:
git checkout main && git pull
git tag prod-v1.2.3 && git push origin prod-v1.2.3
```

Check ancestry before tagging — this is exactly what the guard runs:

```bash
git merge-base --is-ancestor <sha> origin/main && echo OK || echo "NOT on main"
```

`gh release delete <tag>` removes a Release entry if one was created. Reusing a
tag that already produced a Release requires deleting the Release first.

## 7. What is not automated

Everything here is manual, on purpose. No workflow will ever do these for you:

- **Any rollback.** Nothing rolls back on failure — unwinding a half-deploy is a
  human decision, because "roll forward" is usually the right answer.
- **`neonctl branches reset`** — destructive, human-only.
- **Branch restore** — human-only; needs `NEON_API_KEY`, a prod-path credential.
- **`prerelease-*` cleanup** — no automated deletion; see the policy above.
- **Deciding that serving is actually broken.** A red control-plane deploy is not
  a serving outage. Confirm against `{slug}.kept.host` before acting.
