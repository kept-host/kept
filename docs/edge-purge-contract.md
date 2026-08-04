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
