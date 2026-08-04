# Edge Purge Contract

**This document is a contract. E03 writes it; it does not call it.** The callers
are the write-side epics: **E04** (publish, replace), **E06** (rename, delete,
demote), **E07** (status flip, draft expiry). The serving Worker never purges —
it never calls the control plane at all.

Written 2026-08-04 against the E03 cache policy in `apps/edge/src/cache.ts`.
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

## 2. Purge-by-URL only — cache tags are Enterprise-only

Cloudflare's cache-tag purge (`{"tags": [...]}`) requires an **Enterprise** zone
plan and is **not available to this account**. Do not design around it, and do
not emit `Cache-Tag` response headers expecting them to become purgeable later.

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

Limits worth knowing before batching: **30 URLs per request**, and purge-by-URL
is rate limited per zone (1000 calls/minute at the time of writing). Purge on the
write path, one call per affected slug, batching the URL forms of that slug into
the single `files` array.

**Failure handling.** A purge is a control-plane obligation, not a user-facing
one. The write itself (Postgres → R2 → KV) has already succeeded by the time
purge runs; a failed purge must be retried, logged and alerted, **not** rolled
back and **not** surfaced as a publish failure. Until it succeeds the old copy
serves.

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

**Enumerating for multi-file sites (post-v1).** v1 is single-HTML-file, so the
two forms above are complete. When a site holds more than one object, the purge
set is derived from the **version's file list in Postgres** — for every stored
path `p` under `sites/{siteId}/{versionId}/`:

- `https://{slug}.{base}/{p}` for every `p`;
- plus `https://{slug}.{base}/` and `https://{slug}.{base}/{dir}/` for every
  directory prefix `dir` that contains an `index.html`, because the Worker
  resolves those to the index object under a different URL.

Never enumerate by listing R2 — the previous version's objects are still present
and the list is unbounded. The database row is the authority on what URLs exist.

## 5. Which events must purge

| Event | Epic | Purge |
| --- | --- | --- |
| First publish of a new slug | E04 | Yes — a prior 404 for that slug may be cached for up to 60s (`s-maxage=60`); purge makes the new page appear immediately |
| Version replace | E04 | Yes — all URL forms of the slug |
| Rename `old` → `new` | E06 | Yes — **both** slugs. `old` must stop serving; `new` may hold a cached 404 |
| Delete | E06 | Yes — all URL forms of the slug |
| Demote kept → draft | E06 | Yes — status stays `live`, but the 7-day clock restarts and the manifest changed |
| Keep draft → kept | E06 | Yes — same reason |
| Status flip to `under_review` / `quarantined` / `removed` | E07 | Yes — **mandatory**, this is a moderation action; see §6 |
| Draft expiry (`live` → `expired`) | E07 | Yes |
| Grace-period purge / hard delete | E07 | Yes |

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

## 7. What E03 does and does not do

- **Does:** set the headers, key the cache by the bare URL, skip the cache for
  `suspended`/`expired`/`304`/non-`GET`, and write this contract down.
- **Does not:** call `purge_cache`, write KV, write R2, or contact the control
  plane in any way. The serve path is 100% Cloudflare and stays that way.
