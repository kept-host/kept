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

**This is measured, not asserted.** On 2026-08-04 the dev Railway service was
**stopped** — not slept — for eleven minutes while `*.kept-dev.xyz` was probed.
The control plane returned Railway's `502 Application failed to respond`
throughout; the hosted page kept returning 200 with byte-identical content, on
cache-busted URLs that forced the full Worker pipeline (KV read + R2 read) rather
than a cache hit. Branded 404s and reserved-label 301s answered too. See §8.

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

**`--preserve-under-name` is mandatory here, not cosmetic.** Restoring a branch
that has children fails outright:

```
ERROR: Branch has children, preserve_under_name is required
```

On the prod path the branch being restored **always** has at least one child —
the `prerelease-$TAG` branch this procedure restores from. So a plain
`neonctl branches restore` will always fail during a real rollback. Verified by
drill on 2026-08-03.

Connection strings do not change, so no secret rotation is needed — but **open
connections are briefly interrupted**, so restart the Railway service afterwards.
Point-in-time works too (`<source>@2026-08-03T10:00:00Z`), bounded by the history
window below.

**Restore rewrites the branch lineage.** It does not merely copy data back: the
backup branches become **ancestors** of the restored branch. Measured before and
after a real drill:

```
before:  production → dev → drill-backup
after:   production → dev-prerestore → drill-backup → dev
```

Two consequences that matter mid-incident:

- **You cannot delete those branches afterwards.** Neon refuses:
  `cannot delete branch that has children`. They are load-bearing ancestors of
  the branch you just restored, for as long as it exists.
- **Every rollback permanently lengthens the chain** and consumes two slots of
  the 10-branch allowance. Three rollbacks and the project is close to the cap.

Reclaiming those slots means breaking the descendant relationship first —
reparenting the restored branch back onto `production`, then deleting the
orphaned ancestors. **Treat that path as unverified.** The drill confirmed the
deletion failure but did not exercise a reparent: the branch object exposes a
`parent_id`, and Neon documents branch reparenting, but neither the CLI (`neonctl
branches` has no `reparent` subcommand) nor a writable API field was confirmed
during the drill. Establish the exact procedure on a throwaway branch **before**
you need it, not during an incident.

Practical impact: budget the branch cap assuming rollbacks are effectively
permanent until someone does that cleanup. The drill itself left the project at
4 of 10.

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

⚠ **This deletion only works for branches that were never restored _from_.** A
`prerelease-*` branch used in a rollback becomes an ancestor of the live branch
and cannot be deleted — see "Restore rewrites the branch lineage" above. Reparent
first, then delete. Budget for this: a project that has rolled back twice is
carrying four undeletable branches out of ten until someone reparents.

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

## 7. The release smoke and its canary fixture

`pnpm --filter @kept/web smoke:release` is what both deploy workflows run after a
deploy. Since E03 its edge assertion is a **serve** check, not a reachability
check: it fetches a real page out of R2 through the Worker and asserts 200, exact
body bytes, `Content-Type`, an `ETag`, and a 304 on revalidation.

That page is a hand-seeded **canary**, because there is no publish path until
E04. It lives at the first label of `SMOKE_EDGE_URL` (dev: `smoke`, i.e.
`https://smoke.kept-dev.xyz/`), and if it is missing the smoke fails with a 404
and prints the re-seed command:

```bash
# seed / re-seed (idempotent; writes R2 object -> slug pointer -> KV manifest)
pnpm --filter @kept/web seed:canary --edge-url "$SMOKE_EDGE_URL"

pnpm --filter @kept/web seed:canary --edge-url "$SMOKE_EDGE_URL" --status quarantined
pnpm --filter @kept/web seed:canary --edge-url "$SMOKE_EDGE_URL" --remove
```

It reads the same `R2_*` / `KV_NAMESPACE_ID` / `CLOUDFLARE_API_TOKEN` values the
smoke does, so it targets whichever environment those point at. It does **not**
purge — after a re-seed that changes bytes or status, purge the slug's URL forms
yourself (`docs/edge-purge-contract.md` §4).

Two things worth knowing before debugging a red smoke:

- **Every smoke request carries a unique query string.** Live pages are served
  `s-maxage=31536000`, and the edge cache will answer a repeat GET — and
  synthesise the 304 — without the Worker running at all. Without the buster a
  post-deploy smoke could pass entirely on a cached entry and never touch the
  version just deployed.
- **`ETag` comes back weak** (`W/"…"`) through Cloudflare even though R2 mints a
  strong one. The Worker unquotes and unwraps `W/` before handing it to R2, which
  is what makes the 304 leg pass; that path had a real bug in E03 and the smoke
  now guards it on every deploy.

## 8. Stopping the dev control plane (and the independence drill)

Railway's CLI has no "stop this service" verb; the GraphQL API does. Both
mutations below are **dev only** — the token is the dev project token.

```bash
# the active deployment id
curl -sS https://backboard.railway.com/graphql/v2 \
  -H "Project-Access-Token: $RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"query($i:DeploymentListInput!){deployments(input:$i,first:5){edges{node{id status createdAt canRedeploy}}}}","variables":{"i":{"serviceId":"<service>","environmentId":"<environment>"}}}'

# stop it (the service goes to CRASHED and the domain returns 502)
… -d '{"query":"mutation($id:String!){deploymentStop(id:$id)}","variables":{"id":"<deployment>"}}'

# bring it back — this creates a NEW deployment and the old id goes REMOVED
… -d '{"query":"mutation($id:String!){deploymentRedeploy(id:$id){id status}}","variables":{"id":"<deployment>"}}'
```

Two gotchas learned the hard way on 2026-08-04:

- Railway's API sits behind Cloudflare and answers a default Python/urllib
  user-agent with `403 error code: 1010`. Send a normal `User-Agent`.
- **`deploymentRedeploy` rebuilds** (`BUILDING` → `DEPLOYING`, ~65 s on dev) and
  the old deployment id is retired. Do not assume a stop is instantly reversible:
  budget a build, and never run this against prod.

**Drill result, 2026-08-04** (closes the item E02 task 010 deferred, which had
only ever observed a *slept* service):

| Time (UTC) | Event |
| --- | --- |
| 06:21:21 | Baseline: `/api/health` 200; canary 200, sha `3da72c56…` |
| 06:21:22 | `deploymentStop` → `true` |
| 06:21:38 | Control plane 502 `Application failed to respond`; deployment `CRASHED` by 06:21:58 |
| 06:22:13–06:22:34 | Canary 200 on three cache-busted GETs (KV + R2 each time), 0.17–0.25 s, identical sha; plain URL 200 in ~0.10 s; unknown slug → branded 404; `www` → 301 |
| 06:31:32 | `deploymentRedeploy` → new deployment, `BUILDING` |
| 06:32:39 | `/api/health` 200 again; deployment `SUCCESS` at 06:33:32 |

Serving was unaffected for the entire outage. If this ever fails, something on
the serve path is calling the control plane and that is a design bug, not a
config problem.

## 9. What is not automated

Everything here is manual, on purpose. No workflow will ever do these for you:

- **Any rollback.** Nothing rolls back on failure — unwinding a half-deploy is a
  human decision, because "roll forward" is usually the right answer.
- **`neonctl branches reset`** — destructive, human-only.
- **Branch restore** — human-only; needs `NEON_API_KEY`, a prod-path credential.
- **`prerelease-*` cleanup** — no automated deletion; see the policy above.
- **Deciding that serving is actually broken.** A red control-plane deploy is not
  a serving outage. Confirm against `{slug}.kept.host` before acting.
