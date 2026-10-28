# Edge Purge Contract

**This document is a contract. E03 writes it; it does not call it.** The callers
are the write-side epics: **E04** (publish, replace), **E06** (rename, delete,
restore, late keep, account deletion), **E07** (status flip, draft expiry). The
serving Worker never purges — it never calls the control plane at all.

Written 2026-08-04 against the E03 cache policy in `apps/edge/src/cache.ts`.
Amended 2026-10-04 by E06: restore is the replace event (§5, §7.3); rename is
unchanged; keep and demote are recorded as not purging, as built.
Amended 2026-10-16 by E07: every write to an existing page goes through
`syncManifest` (§5), and owed purges are durable `pending_purges` rows that the
`repurge` job replays (§3).
Amended 2026-10-22 by E08 (multi-file sites, D14): every purge covers the whole
file set from `site_version_files` (§4), 100 URLs a request with one
`pending_purges` row per batch (§3), replace and restore purge old ∪ new (§5);
§2 corrected for Cloudflare's 2025-04-01 change — URL purge is still the method;
§4 names the short-cached URLs no purge covers (SPA routes, the `/about` 301);
the purge job deletes at most 2,000 objects a run (§5).
Secret **values** never appear here; names refer to the GitHub Environment keys
defined in E02 task 004.

## 1. Why purge exists at all

The Worker serves live content with:

```
Cache-Control: public, max-age=60, s-maxage=31536000
```

A year at the edge, no `stale-while-revalidate`. Nothing expires on its own.
**The only thing that makes a replaced, renamed, demoted, suspended or deleted
page stop serving is an explicit purge call from the control plane.** If the
write path forgets a purge, the stale copy serves for a year.

## 2. Purge-by-URL only — by decision, not by plan (E08 D14)

Until 2025-04-01 cache-tag purge (`{"tags": [...]}`) was Enterprise-only. Since
then Cloudflare offers **every purge method — tag, prefix, hostname and URL — on
every plan** ([changelog](https://developers.cloudflare.com/changelog/post/2025-04-01-purge-for-all/)).
kept **still purges by URL only**, for two reasons (E08 D14):

- **Rate.** On the Free plan tag, prefix and hostname purge are limited to
  **5 requests a minute** (bucket 25). A busy hour of replaces would queue behind
  that limit; URL purge's limit (§3) is per URL and far higher.
- **Reach.** Cloudflare's docs describe the Workers Cache API (`caches.default`,
  which is where the Worker stores pages) as a separate store and do not say
  these methods reach it. URL purge is proven against it on dev (2026-08-05).

Do not add a tags branch, and do not emit `Cache-Tag` response headers.

- **Q4 — hostname purge on dev, run 2026-10-22 (E08 task 005).** A dev page was
  served from KV into `caches.default` (`s-maxage=31536000`), its R2 object was
  overwritten in place (the edge kept serving the old bytes), then
  `{"hosts": ["{slug}.kept-dev.xyz"]}` was sent: Cloudflare answered `success`
  and the next request served the new bytes within 3 s. So **hostname purge does
  reach the Cache API** — one run, one colo. It does not change D14: the Free
  rate (5/min) still rules it out as the write path. It is the candidate for a
  plan whose hostname-purge rate fits, for very large sites.
- **Q5 — Cloudflare "Workers Caching"** (`ctx.cache.purge()`, tag and prefix
  purge built for Workers) is a possible later replacement for the Cache API
  layer. Out of scope for v1; noted for the self-host / scaling work.

The available mechanism is **purge-by-URL**, and that forces the cache key: the
Worker stores entries under the **bare public request URL**, with no `Vary` and
nothing manifest-derived (`siteId`, `versionId`, `status`) mixed in. Mixing
anything in makes the purge miss. This is enforced by comment and by
construction in `apps/edge/src/cache.ts`.

## 3. The API call

```
POST https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache
Authorization: Bearer {CLOUDFLARE_API_TOKEN}
Content-Type: application/json

{"files": ["https://foo.kept.host/", "https://foo.kept.host/index.html"]}
```

| Item        | dev                                | prod                            |
| ----------- | ---------------------------------- | ------------------------------- |
| Zone        | `kept-dev.xyz`                     | `kept.host`                     |
| Serving host| `{slug}.kept-dev.xyz`              | `{slug}.kept.host`              |
| Token       | `CLOUDFLARE_API_TOKEN` (dev env)   | `CLOUDFLARE_API_TOKEN` (prod)   |

The token scope **already exists** — E02 task 004 provisioned `Cache Purge`,
zone-scoped to `kept-dev.xyz` on the dev token and `kept.host` on the prod token.
No new credential is needed. Cache Purge is one of the few permissions Cloudflare
lets you fence per-zone, so a dev token genuinely cannot purge prod.

The zone id is not currently a configured variable in either environment. The
first epic to implement a purge (E04) must add `CLOUDFLARE_ZONE_ID` to the
control plane's environment alongside the existing token, per environment.

Limits worth knowing before batching (checked 2026-10-21,
[purge-cache](https://developers.cloudflare.com/cache/how-to/purge-cache/)):
**100 URLs per request** on Free, Pro and Business (`PURGE_MAX_URLS_PER_REQUEST`,
`apps/web/lib/storage/purge.ts` — the "30" this section used to say is out of
date), and a rate of **800 URLs a second on Free, 1,500 on Pro**. A slug's URLs
go out in batches of 100, one call after another (a 1,000-file Pro site is about
eleven calls), and the delayed second purges follow in the same order after one
wait, so a big set never lands as a single burst.

**Failure handling.** A purge is a control-plane obligation, not a user-facing
one. The write itself (Postgres → R2 → KV) has already succeeded by the time
purge runs; a failed purge must be retried, logged and alerted, **not** rolled
back and **not** surfaced as a publish failure. Until it succeeds the old copy
serves.

**As built (E07): owed purges live in Postgres.** `apps/web/lib/storage/manifest.ts`
records every purge it still owes as a `pending_purges` row (`site_id`, `slug`,
`urls`, `due_at`, `attempts`, `last_error`):

- **One row per batch, before the first call** (E08 D14). Each row is due in
  `KV_REPURGE_DELAY_MS` (125 s) for that batch's second purge (§6); the
  in-process timer deletes a batch's row when its second purge lands, so a
  restart or redeploy in between leaves rows instead of a stale edge. Only the
  first batch's row names the site, so one failed sync of a big set is one
  re-sync, not one per batch.
- A refusal on batch *k* moves batches *k…n* to due-now — they never reached the
  edge — and stops; the batches before *k* keep their second purge. An unset
  `CLOUDFLARE_ZONE_ID` is such a refusal (every batch's row, URLs included, goes
  due now). A purge whose URLs cannot be built at all (`KEPT_BASE_DOMAIN` unset
  or malformed) writes one row due now with no URLs; its replay derives them
  from the site's current set. There is no in-process retry.
- A `syncManifest` whose store write **fails** writes a row due now with no
  URLs; its replay is the sync itself.
- Inside `syncManifest` the row is written on the sync's own transaction (in a
  savepoint), never on a second pooled connection.

The `repurge` job (`POST /api/cron/repurge`, every 12 minutes on the scheduler
Worker `apps/scheduler`, under `CRON_SECRET`; `.github/workflows/cron-repurge.yml`
runs it by hand) replays due rows in batches
(`apps/web/lib/storage/repurge.ts`). A row that names a site is re-synced first
(`syncManifestForReplay`, which reads the row as it stands now), then its own
batch is purged, and it is kept due in 125 s for that write's own second purge
(the batch ∪ the site's current set). A row with no URLs is given the site's
current set under the row's slug, from `site_version_files` — the old name, for
a rename — or the root forms when it names no site. A row without a site is
purged, then deleted, or deferred until 125 s after it was created. Each failure
counts an attempt and retries 125 s later. After `REPURGE_MAX_ATTEMPTS` (5) the
row stays in the table, is never selected again, and the run sends one admin
alert listing every such row; reset `attempts` to replay it.

## 4. The URL forms to purge for one slug

`purge_cache` matches the **exact** URL string. `https://foo.kept.host/` and
`https://foo.kept.host/index.html` are two different cache entries even though
the Worker serves the same R2 object for both (`r2.ts` maps a trailing-slash path
to `index.html`). Both must be listed.

For a slug `{slug}` on base domain `{base}`, the minimum set is:

```
https://{slug}.{base}/
https://{slug}.{base}/index.html
```

Scheme is always `https`. There is no `http` entry to purge (the zone redirects)
and no `www.{slug}` form (the Worker only answers single-label hosts).

**Enumerating multi-file sites — in force since E08.** Every version is a file
set (E08 D1), and the purge set is derived from the **version's file list in
Postgres** (`site_version_files`) — for every stored path `p` under
`sites/{siteId}/{versionId}/`:

- `https://{slug}.{base}/{p}` for every `p`, each segment encoded once with
  `encodeURIComponent` (the Worker's `resolvePath` decodes once);
- plus `https://{slug}.{base}/` and `https://{slug}.{base}/{dir}/` for every
  directory prefix `dir` that contains an `index.html`, because the Worker
  resolves those to the index object under a different URL.

`setPurgeUrls(slug, paths)` in `apps/web/lib/storage/manifest.ts` builds it,
always leading with the two root forms above, so a single-file set purges
exactly what it did before E08. Never enumerate by listing R2 — the previous
version's objects are still present and the list is unbounded. The database row
is the authority on what URLs exist.

Two URL families are **not** in that list, because no file row names them; the
Worker caches both for 60 s (`SHORT_EDGE_CACHE_CONTROL`) instead of a year, so a
replace reaches them within a minute without a purge:

- an SPA's rewritten routes (`/dashboard/settings` served from the root
  `index.html`, E08 D12, Q-new-1);
- the `301` from `/about` to `/about/` on a non-SPA site that has
  `about/index.html` (Q-new-6).

A miss (branded or custom `404.html`, D13) was already short-cached.

## 5. Which events must purge

| Event | Epic | Purge |
| --- | --- | --- |
| First publish of a new slug | E04 | Yes — a prior 404 for that slug may be cached for up to 60s (`s-maxage=60`); purge makes the new page appear immediately. **The only direct `writeManifest` left** (`apps/web/lib/publish/pipeline.ts`); a failed first publish unwinds with `removeManifest` |
| Version replace (owner, anonymous) | E04 | Yes — through **`syncManifest(siteId, { alsoPurgeVersionId })`** after the replace commits (E07): every URL of the **old ∪ new** version's sets (E08 D14), or a path only the old set had keeps serving its old bytes for a year. A failed replace unwinds by re-running `syncManifest`, so the edge returns to whatever the row says |
| Restore a previous version | E06 | Yes — **restore is the replace event.** The manifest (and pointer) is rewritten to an older `versionId` whose objects are already in R2; no page object is written. Same targets (restored ∪ replaced set), same delayed second purge, same `syncManifest` call as a replace; the manifest's `spa` / `has404` are the restored version's (`apps/web/lib/sites/restore.ts`) |
| Rename `old` → `new` | E06 | Yes — **both** slugs, the whole set on each. `old` must stop serving; `new` may hold a cached 404. `syncManifest` writes `new` from the row, then `removeManifest(old, siteId)` purges the current set at the old host (`apps/web/lib/names/rename.ts`) |
| Delete (owner, bulk, anonymous, account deletion) | E06 | Yes — every URL of the current set (`removeManifest(slug, siteId)` reads it from Postgres). **Edge first** (E07 AC42, D-65): `removeManifest` runs before the row is archived, so a delete that answers "done" is already offline; the row change then runs under the site lock (account deletion: `lockOwner`) and re-checks the status; every delete ends with `syncManifest` for each site it touched, whether the row change committed or was refused, which undoes any writer that slipped a manifest back in between. Owner and anonymous delete refuse `under_review` / `quarantined` / `removed` (D-66); account deletion takes every page (D-68) |
| Demote kept → draft | E06, E10 | **Yes (E10 D5).** The status stays `live`, but the manifest's `badge` flips from the kept to the draft variant, so `demoteSite` runs `syncManifest` after its commit (`apps/web/lib/sites/keep.ts`). A failed sync is logged and left to its `pending_purges` row — the page still serves |
| Keep draft → kept (owner, bulk, anonymous) | E06, E10 | **Yes (E10 D5)** — the badge flips to the kept variant and `ownerId` is no longer left stale: `keepSite`, `keepSites` and `keepAnonymousPage` run `syncManifest` after the commit. A no-op keep of an already-kept page writes nothing. A **late keep** (`expired` within grace → `live`) is the same sync, and its failure is the caller's error (the page is not back online) |
| Swap (demote A, keep B) | E06, E10 | **Yes, both pages (E10 D5)** — one commit, then `syncManifest(A)` and `syncManifest(B)` |
| Details save (model, "Made with", Remix, README, prompt) | E10 | **Yes, when a value the badge or the README page shows changed (Q5)** — `syncManifest` after the save, plus `/_kept/readme` when the README changed (task 006). A title-only save on a page without a README writes no KV |
| Badge style (standard ↔ minimal) | E10 | **Yes, every kept page the owner serves — queued, not inline (Q4).** `resyncOwnerPages(profileId)` (`apps/web/lib/badge/fan-out.ts`) inserts one `pending_purges` row per page (`urls: []`, due now) in one statement; the `repurge` job replays each as `syncManifest` + purge (task 009) |
| Handle change | E10 | **Yes** — after the commit, every old handle's redirect manifest `{ redirectTo: <current>, updatedAt }` is written (`writeRedirectManifest`: pointer → KV → the double purge of `https://{old}.{base}/` and `/index.html`; the Worker caches a redirect 60 s, so deeper paths need none); taking an old handle back removes its redirect (`removeManifest(handle)`, the same two URLs); and every kept page's badge is re-synced through `resyncOwnerPages`, queued, as for the badge style. Account deletion removes every old handle's redirect the same way (task 008) |
| Badge backfill | E10 | **Yes, queued** — `pnpm --filter @kept/web admin:badge-backfill [--limit N]` queues one re-sync per `live` page, oldest first, for the manifests written before E10; the `repurge` job writes them. One KV write each — on dev, run with a limit after 00:00 UTC |
| Status flip to `under_review` / `quarantined` / `removed` / back to `live` | E07 | Yes — **mandatory**, this is a moderation action; see §6. `setStatus` (`apps/web/lib/moderation/status.ts`) commits, then `syncManifest`: a written manifest for `under_review` / `quarantined` (451), a removed one for `removed` |
| Draft expiry (`live` → `expired`) | E07 | Yes — the hourly `expire` job commits `expired`, then `syncManifest` writes the `expired` manifest (410) |
| Grace-period purge / hard delete | E07 | Yes — the daily `purge` job calls `removeManifest` (skipped when another page now claims the slug), deletes every file of every version (from `site_version_files`, `deleteMany`), then the row. At most `PURGE_DELETES_PER_RUN` (2,000) objects a run (E08 Q2): a site cut off part-way deletes what it took and keeps its row, name and manifest — it is in a status the edge serves no bytes for — and the next run finishes it |

**The rule as built (E07 D18).** For any page that already exists, the only
manifest write is `syncManifest(siteId)` (`apps/web/lib/storage/manifest.ts`). In
one transaction it locks the site row, reads `slug`, `status`,
`current_version_id`, `owner_id`, `region`, the current version's `spa` /
`has_404` (written only when true), the badge's inputs (E10 D3: the row's display
switches and the owner's profile, built by `badgeDataFor`) and the file paths it will purge (E08), writes the manifest (`live`,
`under_review`, `quarantined`, `expired`) or removes it (`removed`, `archived`),
and commits only after KV has answered. Callers run it **after** their own commit,
never inside it. Whatever order writers commit in, the last sync reads the last
row, so a stale `live` can never land after a flag. The only exceptions are the
brand-new publish (above), the edge-first deletes (which end with a sync) and the
purge job (which deletes the row).

Rule of thumb: **if the KV manifest for a slug is written, purge that slug.** The
manifest is what the Worker reads; a manifest write with no purge is a stale
edge. There is no manifest write that is safe to skip a purge for.

## 6. The propagation floor — a purge is NOT instant for status flips

`apps/edge/src/manifest.ts` reads KV with
`MANIFEST_KV_CACHE_TTL_SECONDS = 60` (`cacheTtl: 60`). **60 seconds is
Cloudflare's minimum accepted value** — it cannot be lowered.

**A KV write does not invalidate a `cacheTtl` entry.** The KV edge cache is a
second, separate layer beneath the Cache API, and `purge_cache` does not touch
it. So after a successful purge-by-URL:

- the Cache API entry is gone immediately;
- the next request re-reads KV — but that read can still be served from the KV
  edge cache in that colo, returning the **pre-flip** manifest;
- the flip is therefore effective **up to 60 seconds later, per colo**.

State it plainly to anyone who needs to know: **suspension is not instant.**
A moderator quarantining a page should expect up to a 60-second tail even when
the purge call returns success, and that tail is independent per Cloudflare
location. Do not build a moderation UI that claims the page is already dark, and
do not write an acceptance test that asserts a status flip is visible on the very
next request.

For a takedown that genuinely cannot wait 60 seconds, the escalation is to delete
the R2 object as well — the Worker's `missing` branch then serves the branded 404
regardless of what the cached manifest says.

### The tail does not end on its own — CORRECTION, 2026-08-05

"Up to 60 seconds later" above is wrong for anything the Worker caches with
`LIVE_CACHE_CONTROL`, and the error is not a detail. Walk it through:

1. the purge empties the Cache API entry;
2. the next request misses, and the Worker re-reads KV — from the colo's KV read
   cache, so it gets the **pre-change** manifest;
3. the Worker serves that stale answer and stores it under `s-maxage=31536000`;
4. **nothing expires it, and while it answers no further KV read ever happens.**

So a single purge converts a bounded propagation window into a *permanent* stale
edge. Observed on deployed dev with `DELETE /api/anon/:token`: KV key gone,
pointer gone, a cache-busting URL 404ing — and the live URL still serving 200
minutes later, having been re-cached three seconds after the delete.

**The control plane therefore purges twice**: once immediately, and again after
`2 × MANIFEST_KV_CACHE_TTL_SECONDS` (`KV_REPURGE_DELAY_MS` in
`apps/web/lib/storage/manifest.ts`). The factor of two is the bound, not padding —
the colo's KV entry has at most one `cacheTtl` of life left when the change lands,
and the one stale read it permits refreshes it by at most another. One stale read
per purge is the most that is possible, which is why one retry is enough.

Restated for anyone sizing a UI or a test: a change is effective in **seconds** in
the common case and **up to ~2 minutes** in the worst case, not 60 seconds.

### Measured on dev, 2026-08-04 (E03 task 009) — the floor is a ceiling, not a wall

The 60-second figure above is the documented worst case. It was measured against
the deployed dev Worker and the real KV namespace, and **the observed lag is
sub-second**:

- A cold GET populated the colo's KV cache with `status: live`. Five seconds
  later (and again at twenty seconds, both well inside the 60-second `cacheTtl`
  window) the manifest was rewritten to `quarantined` and the URL purged. The
  edge answered **451 within ~0.4 s of the KV write** — 149 ms and 163 ms after
  the purge call returned — in both runs.
- The full status matrix (`live → under_review → quarantined → expired →
  removed → live`) flipped within 0–1 s of each write, purge included.

So on current Cloudflare KV a write appears to invalidate the cached value
rather than waiting the `cacheTtl` out. **Do not rewrite the guidance above on
the strength of that.** The measurement is one colo (FRA), one namespace, one
account, and Cloudflare documents up to 60 seconds; a moderation UI that promises
instant darkness is still wrong, and an acceptance test that asserts a flip is
visible on the very next request is still flaky by design. Treat sub-second as
the common case and 60 seconds as the number you owe the operator.

**What is NOT sub-second:** anything still in the Cache API. Measured in the same
run — with the manifest already flipped and the purge not yet issued, the edge
kept serving the old cached page. That is the intended design (a cache hit costs
zero store reads), and it is why §5 is mandatory: **the purge, not the KV write,
is what makes a flip visible.**

## 7. The slug pointer object — a HARD write-side obligation

**This section is not optional and not a nice-to-have.** The Worker already
reads the object described here (`apps/edge/src/manifest.ts`, task 007). Nothing
writes it yet, so the fallback is currently inert: every probe misses and every
path returns exactly what it returned before. **E04 must start writing it, or
the first-read-after-publish 404 that this whole mechanism exists to prevent
stays unprevented.**

### 7.1 Why it has to exist

KV is eventually consistent — a freshly written manifest can take up to ~60s to
be readable at every colo. The person most likely to open a link within that
window is the person who just published it. So on a **true KV miss** the Worker
performs **one** R2 `get` (R2 is strongly read-after-write consistent) before
falling through to the branded 404.

R2 is keyed by `siteId` — `sites/{siteId}/{versionId}/{path}` — and that is a
locked decision, because it is what makes a rename a KV-only write with no file
move. It also means **a KV miss leaves the Worker with no way to address the
object**: the slug alone cannot produce a key. A slug-addressable pointer is
therefore the only shape this fallback can take.

### 7.2 The object

```
key:          slugs/{slug}.json
content-type: application/json
body:         the KV manifest value, byte-identical
```

```json
{
  "siteId": "…",
  "versionId": "…",
  "status": "live",
  "region": "auto",
  "ownerId": "…" ,
  "updatedAt": 1770000000000
}
```

Same bucket as the page objects (`KEPT_R2`), same schema (`kvManifestSchema` in
`@kept/shared`) — the Worker validates the pointer with the exact same parser it
uses on the KV value, and an unparseable pointer is simply a branded 404.

### 7.3 The ordering rules — the part that is easy to get wrong

**The pointer must be at least as fresh as KV at every instant.** The Worker
reads it precisely when KV cannot answer, so a stale pointer is a page that
serves content the control plane already changed.

| Write | Order | Why |
| --- | --- | --- |
| Publish / replace / any manifest change | **R2 object → `slugs/{slug}.json` → KV** | The pointer must be readable before the KV entry exists, or the propagation window is not covered at all |
| Restore a previous version (E06) | **`slugs/{slug}.json` → KV** (no R2 object write — the older version's object already exists; `restore.ts` only `get`s it) | The replace row minus its first step: the object being pointed at was written when that version was published |
| Rename `old` → `new` | write `slugs/{new}.json` → write KV `new` → **delete `slugs/{old}.json`** → delete KV `old` | Same rule applied twice: create pointer-first, remove pointer-first |
| Delete / hard delete | **delete `slugs/{slug}.json` → delete KV `{slug}`** | Reverse of publish. Deleting KV first leaves a window where the Worker misses KV, finds the pointer, and **resurrects a deleted page** |
| Status flip (`under_review`, `quarantined`, `removed`, `expired`) | **write `slugs/{slug}.json` → write KV** | A moderation flip that updates KV but not the pointer leaves a `live` pointer that serves the page whenever KV misses |

Stated as one rule, which is the version to remember:

> **Every KV manifest write is preceded by an identical pointer write. Every KV
> manifest delete is preceded by a pointer delete. There is no manifest mutation
> that touches KV and not the pointer.**

This is the same shape as the purge rule in §5 ("if the KV manifest for a slug
is written, purge that slug") and belongs in the same code path. A write helper
that does *pointer → KV → purge* in that order satisfies both sections at once,
and is the recommended way to implement it.

### 7.4 Cost, and what the Worker will not do

- The probe is **one `get`**. No retry, no `list`, no loop, no second KV read.
- Budget: **1 KV + ≤2 R2** on a cold fallback (pointer probe + object), **1 KV +
  1 R2** on the normal cold path, **0 + 0** on a cache hit.
- A slug that fails the Worker's shape check never reaches either store, so an
  invalid label still costs zero operations.
- A page served *through* the fallback is cached with the short
  `s-maxage=60` — not the year-long `LIVE_CACHE_CONTROL` — because the manifest
  it came from is provisional until KV catches up.
- The Worker **never writes** the pointer, never deletes it, and never calls the
  control plane. Writing it is entirely a control-plane job.

**Verified live on dev, 2026-08-04 (E03 task 009).** A slug was seeded with
object + pointer + KV, then its **KV key was deleted** to force the miss path.
The page kept serving 200 — and served it with `s-maxage=60`, not the year-long
`LIVE_CACHE_CONTROL`, which is the observable signature of a response that came
through the pointer rather than through KV. The fallback works against the real
stores; it is inert in production only because nothing writes the pointer yet.
`apps/web/scripts/seed-edge-canary.ts` implements the §7.3 write ordering and is
the reference for E04.

### 7.5 Cleanup

The pointer is one small JSON object per live slug. It is deleted by the delete
path above, so there is nothing to garbage-collect in the normal case. If a
divergence audit is ever wanted, the authority is Postgres — never an R2 `list`.

## 8. What E03 does and does not do

- **Does:** set the headers, key the cache by the bare URL, skip the cache for
  `suspended`/`expired`/`304`/non-`GET`, read `slugs/{slug}.json` on a KV miss,
  and write this contract down.
- **Does not:** call `purge_cache`, write KV, write R2 (**including the pointer
  object in §7**), or contact the control plane in any way. The serve path is
  100% Cloudflare and stays that way.
