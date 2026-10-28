/**
 * The manifest write helper — `docs/edge-purge-contract.md` §5 + §7.3 in one
 * place. THIS MODULE IS THE ONLY THING IN THE REPO THAT MUTATES A KV MANIFEST.
 *
 * The contract states one rule:
 *
 *   > Every KV manifest write is preceded by an identical pointer write. Every
 *   > KV manifest delete is preceded by a pointer delete. There is no manifest
 *   > mutation that touches KV and not the pointer.
 *
 * and §5 states a second one — "if the KV manifest for a slug is written, purge
 * that slug" — which the contract itself notes is the same rule seen twice:
 * a helper doing **pointer → KV → purge** satisfies both at once. That is this
 * file. `apps/edge` reads `slugs/{slug}.json` precisely when KV cannot answer,
 * so a pointer that lags KV serves content the control plane already changed.
 *
 * THE FULL CHAIN, so the ordering is readable without opening the contract:
 *
 *   new publish:        R2 object → slugs/{slug}.json → KV {slug} → purge
 *   delete:                        delete pointer     → delete KV  → purge
 *   every later write:  commit the row → syncManifest(siteId)
 *                       (replace, restore, rename, keep, demote, swap,
 *                       status flips)
 *   rename (E06):       syncManifest(site) → removeManifest(old)
 *
 * …where "purge" is TWO purges, the second one delayed. One is not enough and
 * the reason is not obvious — see `repurgeAfterKvPropagation`. Both are DURABLE
 * (E07 §6.14): a `pending_purges` row per batch is written before the first call
 * and deleted when its second purge lands, so a restart that loses the timer — or
 * a refusal part-way — leaves rows the `repurge` job replays (`./repurge.ts`).
 *
 * ── E08 D14: A PURGE COVERS THE WHOLE FILE SET ──────────────────────────────
 * The edge caches every path of a site for a year, so every purge names every
 * path it may hold under that slug: the files of the version(s) involved, read
 * from `site_version_files` (never an R2 list), plus `/` and each `dir/` that
 * holds an `index.html` (`setPurgeUrls`). A replace or restore purges the OLD and
 * the NEW version's paths (`alsoPurgeVersionId`), or a removed file keeps
 * serving its old bytes. Batched at `PURGE_MAX_URLS_PER_REQUEST`.
 *
 * ── D18: THE MANIFEST ENDS UP MATCHING THE ROW ─────────────────────────────
 * A writer that checks `status` early and writes `status: "live"` late undoes
 * any flag, hide or expiry that committed in between. So every write after a
 * page's first publish goes through `syncManifest`, which reads the row UNDER
 * ITS LOCK and holds that lock until KV has answered. Only a brand-new publish
 * writes a literal manifest — no row exists yet for anyone else to change.
 *
 * The R2 *page object* write is the caller's (E04 task 005) and happens BEFORE
 * `writeManifest`; this helper never touches `sites/{siteId}/{versionId}/…`.
 * E06 and E07 express their rows as calls to the two functions below — if they
 * ever need to reach past this module, the API here is wrong.
 *
 * A `kv.put(slug, …)` / `kv.delete(slug)` anywhere else in the repo is a bug: it
 * writes a manifest with no pointer and no purge, which is the stale-edge /
 * resurrected-page failure this exists to prevent. `apps/web/eslint.config.mjs`
 * carries a `no-restricted-imports` rule that makes importing the KV client
 * outside this module a lint error.
 *
 * NO MODULE-LEVEL STORE CLIENTS. `r2Store()` / `kvStore()` re-read and re-
 * validate the environment on every call (see `./env`); hoisting one into a
 * const would pin a rotated credential for the life of the process.
 */
import { setTimeout as sleep } from "node:timers/promises";

import {
  kvManifestSchema,
  MANIFEST_KV_CACHE_TTL_SECONDS,
  README_PAGE_PATH,
  SITE_INDEX,
  type KvManifest,
  type SiteStatus,
} from "@kept/shared";
import { z } from "zod";

import { badgeDataFor } from "../badge/badge-data";
import { db, type Tx } from "../db";
import {
  currentVersionPaths,
  deferPendingPurges,
  deletePendingPurge,
  insertPendingPurge,
  lockSiteForSync,
  type PendingPurgeInput,
} from "../db/queries/manifest-sync";
import { versionPaths } from "../db/queries/version-files";

import { servingBaseDomain } from "./env";
import { kvStore } from "./kv";
import { purgeBatches, purgeUrls, type PurgeResult } from "./purge";
import { r2Store } from "./r2";

/**
 * `slugs/{slug}.json` — the pointer object the Worker probes on a KV miss
 * (contract §7.2). A pure key formatter; it touches no store. The two ENTRY
 * POINTS that mutate a manifest are `writeManifest` and `removeManifest`.
 */
export function pointerKey(slug: string): string {
  return `slugs/${slug}.json`;
}

/**
 * Every URL the Worker can serve a file set under (contract §4): each path, plus
 * the directory form of each `index.html` (`index.html` → `/`, `a/b/index.html`
 * → `/a/b/`). `purge_cache` matches the URL string exactly, so `/` and
 * `/index.html` are two separate cache entries even though they resolve to the
 * same R2 object — purging one and not the other leaves a stale edge for up to a
 * year. Pure; touches no store.
 *
 * The root forms come first and ALWAYS: every set has a root `index.html` (D7),
 * and a version with no file rows still served at `/`. A single-file set is
 * therefore exactly `slugPurgeUrls(slug)`. Each segment is encoded with
 * `encodeURIComponent` — the Worker's `resolvePath` decodes the request path
 * once, so this is the form that resolves to the stored path. Deduplicated.
 *
 * Throws if `KEPT_BASE_DOMAIN` is unset or malformed. Callers inside this module
 * catch that, because a config gap must degrade to a logged purge failure and
 * never to a failed publish.
 */
export function setPurgeUrls(slug: string, paths: readonly string[]): string[] {
  const origin = `https://${slug}.${servingBaseDomain()}/`;
  const urls = new Set<string>();
  for (const path of [SITE_INDEX, ...paths]) {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    if (path === SITE_INDEX || path.endsWith(`/${SITE_INDEX}`)) {
      urls.add(origin + encoded.slice(0, -SITE_INDEX.length));
    }
    urls.add(origin + encoded);
  }
  return [...urls];
}

/**
 * The root forms alone — what a slug owes when no site row says more: a
 * brand-new publish, a drill label, a removal that names no site.
 */
export function slugPurgeUrls(slug: string): string[] {
  return setPurgeUrls(slug, []);
}

/**
 * Which step failed, so the caller's rollback can unwind precisely:
 * `validate` and `pointer` ⇒ nothing was written, nothing to unwind;
 * `kv` ⇒ the pointer IS written and must be removed (`removeManifest` is the
 * inverse of the whole sequence and is the intended unwind). A removal's `paths`
 * ⇒ the site's file list could not be read; nothing was removed.
 */
export type ManifestWriteStep = "validate" | "pointer" | "kv";
export type ManifestRemoveStep = "paths" | "pointer" | "kv";

export type ManifestWriteResult =
  | {
      ok: true;
      /** The exact bytes written to BOTH stores. */
      value: string;
      /** Non-fatal by contract §3/§5 — `ok: false` here still means published. */
      purge: PurgeResult;
    }
  | { ok: false; step: ManifestWriteStep; error: string };

export type ManifestRemoveResult =
  | { ok: true; purge: PurgeResult }
  | { ok: false; step: ManifestRemoveStep; error: string };

/**
 * A loggable sentence for `err`. Drizzle wraps every database failure as
 * `Failed query: <sql>\nparams: <params>` with the Postgres error on `cause`, so
 * the first line is kept (never the params) and the cause's own message and
 * SQLSTATE are appended — without them the log says which query failed, never why.
 */
function message(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as { message?: unknown; code?: unknown } | undefined;
  if (typeof cause?.message !== "string") return err.message;
  const code = typeof cause.code === "string" ? ` [${cause.code}]` : "";
  return `${err.message.split("\n")[0]} — cause: ${cause.message}${code}`;
}

/**
 * How long after a successful purge the SECOND purge is issued.
 *
 * TWICE the edge's KV `cacheTtl`, plus five seconds of slack, and the factor of
 * two is the proof rather than padding. At the moment a manifest changes, the
 * colo's KV entry has between 0 and `MANIFEST_KV_CACHE_TTL_SECONDS` of life
 * left, so the one stale read can happen as late as T+ttl and refreshes the
 * entry to T+2·ttl. Past that the next KV read is authoritative.
 */
export const KV_REPURGE_DELAY_MS = (2 * MANIFEST_KV_CACHE_TTL_SECONDS + 5) * 1000;

/**
 * The SECOND purge — issued once the edge's KV read cache can no longer answer
 * with the pre-change manifest.
 *
 * ⚠️ ONE PURGE IS NOT ENOUGH, and contract §6 understates why. `purge_cache`
 * empties the Cache API but does NOT reach the Worker's KV read cache
 * (`cacheTtl: MANIFEST_KV_CACHE_TTL_SECONDS`). So the first request after a
 * purge re-reads the OLD manifest, and the Worker stores that old response under
 * `LIVE_CACHE_CONTROL` — `s-maxage=31536000`. §6 calls this a "60-second tail",
 * but the tail never ends: nothing expires the re-stored entry, and while it
 * answers, no further KV read ever happens to correct it. One purge therefore
 * converts a bounded propagation window into a PERMANENT stale edge.
 *
 * Measured on deployed dev, 2026-08-05, `DELETE /api/anon/:token`: the KV key
 * and the pointer were both gone and a cache-busting URL 404'd, yet three
 * seconds after the delete the live URL was a cache MISS serving 200 with
 * `s-maxage=31536000` — the purge had landed and the deleted page had just been
 * re-cached for a year. It was still serving 200 minutes later, while its
 * `/index.html` form (purged, never re-requested, so never re-poisoned) 404'd.
 *
 * Only ONE stale read is possible per purge, which is what makes a single retry
 * sufficient rather than a loop: once the response is back in the Cache API it
 * answers every request, so nothing refreshes the KV entry again.
 *
 * Exported for the drill in `./manifest.test.ts`, which calls it with a zero
 * delay. `ref: false` so a pending re-purge never holds a process open. It does
 * NOT survive a restart or a redeploy on its own: `purgeOwedUrls` writes the
 * `pending_purges` rows that make it durable before the first purge.
 */
export async function repurgeAfterKvPropagation(
  slug: string,
  urls: readonly string[],
  delayMs: number = KV_REPURGE_DELAY_MS,
): Promise<PurgeResult> {
  await sleep(delayMs, undefined, { ref: false });

  const result = await purgeUrls(urls);
  if (!result.ok) {
    console.error(
      `[kept] re-purge FAILED for slug "${slug}" — ${result.error}. URLs: ${urls.join(", ")}. The first purge succeeded, so the edge may be serving a response re-cached from a stale KV read; replay this purge (contract §6).`,
    );
  }
  return result;
}

/**
 * Where a purge still owed after a store write is recorded. `{ siteId }`: a
 * `pending_purges` row (`siteId` null when no site is known). `null`: nowhere —
 * the caller IS the record. Only the repurge replay passes `null`: its own row
 * carries the attempt count, and a second row per failed replay would multiply
 * every outage into more rows each run.
 *
 * `tx`: the caller's open transaction — `syncManifest`'s, which holds the site
 * row lock across the store write. The row is written ON that connection (in a
 * savepoint), never on a second one from the pool: a sync that held one
 * connection and waited for another would starve the pool (`max: 5`) as soon as
 * five syncs ran at once — a bulk delete's four trailing syncs plus any other
 * request was enough to hang the control plane (E07 task 008).
 */
export type PurgeLedger = { siteId: string | null; tx?: Tx } | null;

/**
 * Record a purge that is still owed, and NEVER throw: the write it follows has
 * already succeeded, and a database hiccup here must not turn it into a
 * failure. Returns the row id, or `null` when nothing was written (no ledger, or
 * logged — the in-process timer, if any, is then the only retry).
 */
async function recordPendingPurge(
  ledger: PurgeLedger,
  input: Omit<PendingPurgeInput, "siteId">,
): Promise<string | null> {
  if (ledger === null) return null;
  try {
    const row = { ...input, siteId: ledger.siteId };
    const { tx } = ledger;
    // A savepoint, so a failed insert cannot abort the sync's transaction.
    return await (tx ? tx.transaction((savepoint) => insertPendingPurge(row, savepoint)) : insertPendingPurge(row));
  } catch (err) {
    console.error(
      `[kept] pending_purges row NOT recorded for slug "${input.slug}" — ${message(err)}. URLs: ${input.urls.join(", ")}. Replay this purge by hand if the process restarts (contract §3).`,
    );
    return null;
  }
}

/**
 * The owed batches are due NOW: they never reached the edge. Never throws — on
 * a database failure they stay due at their later time, which only delays them.
 */
async function owedNow(ledger: PurgeLedger, ids: readonly (string | null)[]): Promise<void> {
  const owed = ids.filter((id): id is string => id !== null);
  if (ledger === null || owed.length === 0) return;
  try {
    const { tx } = ledger;
    const now = new Date();
    await (tx ? tx.transaction((savepoint) => deferPendingPurges(owed, now, savepoint)) : deferPendingPurges(owed, now));
  } catch (err) {
    console.error(
      `[kept] pending_purges rows ${owed.join(", ")} NOT moved to due-now — ${message(err)}. The repurge job replays them at their later due time.`,
    );
  }
}

/**
 * The second purge of each batch that landed, in order, after ONE wait. Each
 * batch's row is deleted when its second purge lands; a failed one keeps its
 * row, so the job retries it.
 *
 * Floating BY DESIGN — see `repurgeAfterKvPropagation`. A delete must not block
 * for two minutes, and contract §3 forbids a purge from failing the operation
 * it follows. The `.catch` is not decoration: this promise is unawaited,
 * `purgeUrls` re-reads the environment on every call, and an unhandled rejection
 * takes the whole Node process down.
 */
function scheduleSecondPurges(slug: string, batches: readonly string[][], ids: readonly (string | null)[]): void {
  if (batches.length === 0) return;
  void (async () => {
    for (const [k, batch] of batches.entries()) {
      // Sequential, one wait in total: the batches stay inside Cloudflare's
      // per-second URL rate (contract §3) instead of landing at once.
      const second = await repurgeAfterKvPropagation(slug, batch, k === 0 ? KV_REPURGE_DELAY_MS : 0);
      const id = ids[k];
      if (second.ok && id) await deletePendingPurge(id);
    }
  })().catch((err: unknown) => {
    console.error(
      `[kept] re-purge THREW for slug "${slug}" — ${message(err)}. The edge may be serving a response re-cached from a stale KV read; the repurge job replays it (contract §6).`,
    );
  });
}

/**
 * Purge `urls` for `slug` in batches of `PURGE_MAX_URLS_PER_REQUEST`, and NEVER
 * throw. By the time this runs the stores already agree; only the edge is
 * stale, and contract §3 is explicit that a failed purge is logged, alerted and
 * retried — not rolled back and not surfaced as a publish failure.
 *
 * DURABLE FIRST (D14): every batch is a `pending_purges` row BEFORE the first
 * call, due once the KV read cache has turned over (its second purge). A
 * refusal on batch k moves batches k…n to due-now — they never reached the edge
 * — and the `repurge` job replays them; the batches before k still get their
 * in-process second purge.
 *
 * Only the FIRST batch's row names the site (`ledger.siteId`): its replay
 * re-runs `syncManifest`, so the edge converges on the row as it stands then.
 * The rest only owe a purge of their own batch — naming the site on each would
 * turn one failed sync of a big set into a KV write per batch.
 *
 * Exported for the batching drill in `./sync-manifest.test.ts`, which hands it a
 * URL Cloudflare refuses: the one way to force a real refusal on a later batch.
 */
export async function purgeOwedUrls(
  slug: string,
  urls: readonly string[],
  ledger: PurgeLedger,
): Promise<PurgeResult> {
  const batches = purgeBatches(urls);
  const dueAt = new Date(Date.now() + KV_REPURGE_DELAY_MS);
  const ids: (string | null)[] = [];
  for (const [k, batch] of batches.entries()) {
    const owner = ledger && k > 0 ? { ...ledger, siteId: null } : ledger;
    ids.push(await recordPendingPurge(owner, { slug, urls: batch, dueAt }));
  }

  for (const [k, batch] of batches.entries()) {
    const result = await purgeUrls(batch);
    if (result.ok) continue;
    console.error(
      `[kept] purge FAILED for slug "${slug}" (batch ${k + 1} of ${batches.length}) — ${result.error}. URLs: ${batch.join(", ")}. The write succeeded; the edge stays stale until the repurge job replays batches ${k + 1}–${batches.length} (contract §3).`,
    );
    // No in-process re-purge of the failed batches: the first call never reached
    // Cloudflare, so a second on the same broken configuration would only log the
    // same failure twice. Their rows, due now, are the retry.
    await owedNow(ledger, ids.slice(k));
    scheduleSecondPurges(slug, batches.slice(0, k), ids.slice(0, k));
    return result;
  }

  scheduleSecondPurges(slug, batches, ids);
  return { ok: true };
}

/**
 * Purge every URL of `paths` under `slug` (`setPurgeUrls`), and NEVER throw.
 *
 * `ledger.siteId` goes on the first batch's row when the caller knows the site:
 * the replay re-syncs it before purging.
 */
async function purgeSlug(slug: string, paths: readonly string[], ledger: PurgeLedger): Promise<PurgeResult> {
  let urls: string[];
  try {
    urls = setPurgeUrls(slug, paths);
  } catch (err) {
    const error = message(err);
    console.error(
      `[kept] purge SKIPPED for slug "${slug}" — ${error}. The stores are correct; the edge may serve a stale copy until this is configured and the purge replayed.`,
    );
    // No URLs to record: the replay derives them from the site's current set
    // (or the slug's root forms) once configured.
    await recordPendingPurge(ledger, { slug, urls: [], dueAt: new Date() });
    return { ok: false, error };
  }
  return purgeOwedUrls(slug, urls, ledger);
}

/**
 * The site a manifest belongs to, for its `pending_purges` row — only when it
 * is one. Drills and the edge canary write manifests for labels that name no
 * row (`e04-drill-…`), which a uuid column would refuse.
 */
function knownSiteId(siteId: string): string | null {
  return z.string().uuid().safeParse(siteId).success ? siteId : null;
}

/**
 * Write a manifest: **pointer → KV → purge**, awaited in that order, never
 * concurrently. The pointer must be readable BEFORE the KV entry exists or the
 * eventual-consistency window it covers is not covered at all (§7.3).
 *
 * The pointer body and the KV value come from ONE `JSON.stringify` of ONE
 * schema-parsed object, so they are byte-identical by construction rather than
 * by two serializations that happen to agree (§7.2). Validation runs before
 * either write: the Worker parses the pointer with this same schema and treats
 * an unparseable one as a branded 404, so validating here is what keeps that
 * impossible.
 */
export function writeManifest(slug: string, manifest: KvManifest): Promise<ManifestWriteResult> {
  return storeManifest(slug, manifest, { siteId: knownSiteId(manifest.siteId) }, []);
}

/** `paths`: the files the purge covers beyond the root forms (`setPurgeUrls`). */
async function storeManifest(
  slug: string,
  manifest: KvManifest,
  ledger: PurgeLedger,
  paths: readonly string[],
): Promise<ManifestWriteResult> {
  const parsed = kvManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"} — ${issue.message}`)
      .join("; ");
    return { ok: false, step: "validate", error: `invalid manifest: ${detail}` };
  }

  // ONE serialization, two stores. Do not stringify again below.
  const value = JSON.stringify(parsed.data);

  try {
    // `putJson` sets `content-type: application/json` (§7.2) and takes the
    // already-serialized string precisely so these bytes are not rebuilt.
    await r2Store().putJson(pointerKey(slug), value);
  } catch (err) {
    return { ok: false, step: "pointer", error: message(err) };
  }

  try {
    await kvStore().put(slug, value, "application/json");
  } catch (err) {
    // The pointer is written and the caller must unwind it — `removeManifest`.
    return { ok: false, step: "kv", error: message(err) };
  }

  return { ok: true, value, purge: await purgeSlug(slug, paths, ledger) };
}

/**
 * Remove a manifest: **delete pointer → delete KV → purge**, the exact reverse
 * of the write.
 *
 * THE ORDER IS THE WHOLE POINT: deleting KV first leaves a window in which the
 * Worker misses KV, probes the still-present pointer, and RESURRECTS A DELETED
 * PAGE. That window is invisible on the happy path — while KV still answers
 * "absent" every request 404s regardless of pointer state — so a wrong-ordered
 * delete passes every test that does not force a KV miss.
 *
 * The R2 page object is the caller's to remove (or, per the pivot, to archive
 * rather than delete) and is untouched here.
 *
 * `siteId`, when the caller has one, makes the purge cover the site's CURRENT
 * file set (read from `site_version_files` before anything is removed) and goes
 * on the `pending_purges` row so a replay re-syncs that site. Rename passes it
 * for the OLD name: that hostname served the same set, and every path of it
 * must stop answering there. Without one, only the root forms are purged.
 */
export async function removeManifest(
  slug: string,
  siteId: string | null = null,
): Promise<ManifestRemoveResult> {
  let paths: string[] = [];
  if (siteId) {
    try {
      paths = await currentVersionPaths(siteId);
    } catch (err) {
      return { ok: false, step: "paths", error: message(err) };
    }
  }
  return unstoreManifest(slug, { siteId }, paths);
}

async function unstoreManifest(
  slug: string,
  ledger: PurgeLedger,
  paths: readonly string[],
): Promise<ManifestRemoveResult> {
  try {
    await r2Store().delete(pointerKey(slug));
  } catch (err) {
    return { ok: false, step: "pointer", error: message(err) };
  }

  try {
    await kvStore().delete(slug);
  } catch (err) {
    return { ok: false, step: "kv", error: message(err) };
  }

  return { ok: true, purge: await purgeSlug(slug, paths, ledger) };
}

/**
 * The statuses with no manifest: the page has left the edge (D18). Every other
 * status — `live`, `under_review`, `quarantined`, `expired` — is served by the
 * Worker from its manifest (a page, the 451, the 410).
 */
const UNSERVED_STATUSES = ["removed", "archived"] as const satisfies readonly SiteStatus[];

function isUnserved(status: SiteStatus): status is (typeof UNSERVED_STATUSES)[number] {
  return (UNSERVED_STATUSES as readonly SiteStatus[]).includes(status);
}

export type SyncManifestResult =
  | {
      ok: true;
      /** `missing`: no row — nothing to say at the edge, nothing written. */
      outcome: "written" | "removed" | "missing";
      /** The slug the edge now answers for (absent when `missing`). */
      slug?: string;
    }
  | { ok: false; slug: string; error: string };

/**
 * D18 — make the edge say what the row says. THE ONE MANIFEST WRITE FOR EVERY
 * PAGE THAT ALREADY EXISTS: replace, restore, rename (the new name), the late
 * keep, every moderation status change and the expiry sweep.
 *
 * In ONE transaction: lock the site row → read `slug, status,
 * current_version_id, owner_id, region`, the current version's `spa` /
 * `has_404` and the badge's inputs → `writeManifest` with exactly those values
 * (`live`, `under_review`, `quarantined`, `expired`) or `removeManifest`
 * (`removed`, `archived`) → commit only after KV has answered. The flags are
 * written only when true; `badge` (E10 D3, `badgeDataFor`) always.
 *
 * E10 D5: every change to what the badge shows is a writer too — keep, demote,
 * swap (both pages), a details save, and — queued as `pending_purges` rows, not
 * inline (`lib/badge/fan-out.ts`) — a handle or badge-style change.
 *
 * The purge covers the current version's file set, read under the same lock,
 * and — with `alsoPurgeVersionId` — that version's too: a replace or restore
 * names the version it moved AWAY from, so a path only the old set had stops
 * serving its old bytes (D14, old ∪ new). Whoever commits a
 * row change and then calls this — in any order, from any writer — leaves the
 * edge on the row's state: a later sync waits on the lock and reads the later
 * row, so a stale `live` can never land after a flag.
 *
 * ⚠️ CALL IT AFTER YOUR OWN COMMIT, never inside your transaction: the lock it
 * takes is the site row's, and a caller still holding that row (or `lockOwner`
 * for a batch — Risk 12) would hold it across a KV round-trip for every page.
 *
 * NEVER THROWS. A failed store write is a value; it leaves a `pending_purges`
 * row due now whose replay is this function again. Callers log it and decide
 * what their own answer is — they never throw past their own commit.
 */
export interface SyncManifestOptions {
  /** A version whose paths the edge may still hold — the one a replace or restore replaced. */
  alsoPurgeVersionId?: string | null;
}

export async function syncManifest(siteId: string, opts: SyncManifestOptions = {}): Promise<SyncManifestResult> {
  const synced = await syncSite(siteId, true, opts);
  if (!synced.ok) {
    console.error(
      `[kept] syncManifest FAILED for site ${siteId} (slug "${synced.slug}") — ${synced.error}. The row is the authority; the repurge job replays this sync.`,
    );
    // No URLs: the replay re-syncs the site, which purges whatever it writes.
    await recordPendingPurge({ siteId }, { slug: synced.slug, urls: [], dueAt: new Date() });
  }
  return synced;
}

/**
 * `syncManifest` for the repurge replay (`./repurge.ts`) ONLY: the same locked
 * sync, but it records no `pending_purges` row of its own — neither for its
 * failure nor for the purges its write owes. The replayed row is the record and
 * the replay updates it; anything else turns each failed replay into one more
 * row to replay.
 */
export function syncManifestForReplay(siteId: string): Promise<SyncManifestResult> {
  return syncSite(siteId, false, {});
}

async function syncSite(siteId: string, durable: boolean, opts: SyncManifestOptions): Promise<SyncManifestResult> {
  try {
    return await db.transaction(async (tx): Promise<SyncManifestResult> => {
      const site = await lockSiteForSync(tx, siteId);
      if (!site) return { ok: true, outcome: "missing" };
      const ledger: PurgeLedger = durable ? { siteId: site.id, tx } : null;

      // Under the lock: a concurrent replace cannot change the set between this
      // read and the purge.
      const versionIds = [...new Set([site.currentVersionId, opts.alsoPurgeVersionId])].filter(
        (id): id is string => typeof id === "string",
      );
      // The README page (E10 D6) rides on every sync: whoever changed what it
      // shows (a details save, a keep, a replace) refreshed the object first,
      // and a demote stops it serving — either way the edge must drop its copy.
      const paths = [...[...(await versionPaths(tx, versionIds)).values()].flat(), README_PAGE_PATH];

      if (isUnserved(site.status)) {
        const removed = await unstoreManifest(site.slug, ledger, paths);
        return removed.ok
          ? { ok: true, outcome: "removed", slug: site.slug }
          : { ok: false, slug: site.slug, error: `${removed.step}: ${removed.error}` };
      }

      if (!site.currentVersionId) {
        // Unexpressible: `kvManifestSchema.versionId` is required. Every publish
        // sets one; a row without it is an anomaly for a human, so the replay
        // fails until one looks (then alerts).
        return { ok: false, slug: site.slug, error: `site ${site.id} is ${site.status} with no current version` };
      }

      const written = await storeManifest(
        site.slug,
        {
          siteId: site.id,
          versionId: site.currentVersionId,
          status: site.status,
          region: site.region,
          ownerId: site.ownerId,
          updatedAt: Date.now(),
          ...(site.spa && { spa: true }),
          ...(site.has404 && { has404: true }),
          badge: badgeDataFor(site),
        },
        ledger,
        paths,
      );
      return written.ok
        ? { ok: true, outcome: "written", slug: site.slug }
        : { ok: false, slug: site.slug, error: `${written.step}: ${written.error}` };
    });
  } catch (err) {
    // The lock or the read itself failed. No slug is known; the row is the
    // site's, so the replay re-syncs it by id.
    return { ok: false, slug: "", error: message(err) };
  }
}
