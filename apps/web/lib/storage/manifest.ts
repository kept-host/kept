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
 *                       (replace, restore, rename, late keep, status flips)
 *   rename (E06):       syncManifest(site) → removeManifest(old)
 *
 * …where "purge" is TWO purges, the second one delayed. One is not enough and
 * the reason is not obvious — see `repurgeAfterKvPropagation`. The delayed one
 * is DURABLE (E07 §6.14): a `pending_purges` row is written before it is
 * scheduled and deleted when it lands, so a restart that loses the timer leaves
 * a row the `repurge` job replays (`./repurge.ts`).
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
  type KvManifest,
  type SiteStatus,
} from "@kept/shared";
import { z } from "zod";

import { db } from "../db";
import {
  deletePendingPurge,
  insertPendingPurge,
  lockSiteForSync,
  type PendingPurgeInput,
} from "../db/queries/manifest-sync";

import { servingBaseDomain } from "./env";
import { kvStore } from "./kv";
import { purgeUrls, type PurgeResult } from "./purge";
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
 * Both URL forms the Worker can serve a slug under (contract §4). `purge_cache`
 * matches the URL string exactly, so `/` and `/index.html` are two separate
 * cache entries even though they resolve to the same R2 object — purging one and
 * not the other leaves a stale edge for up to a year. Pure; touches no store.
 *
 * Throws if `KEPT_BASE_DOMAIN` is unset or malformed. Callers inside this module
 * catch that, because a config gap must degrade to a logged purge failure and
 * never to a failed publish.
 */
export function slugPurgeUrls(slug: string): string[] {
  const base = servingBaseDomain();
  return [`https://${slug}.${base}/`, `https://${slug}.${base}/index.html`];
}

/**
 * Which step failed, so the caller's rollback can unwind precisely:
 * `validate` and `pointer` ⇒ nothing was written, nothing to unwind;
 * `kv` ⇒ the pointer IS written and must be removed (`removeManifest` is the
 * inverse of the whole sequence and is the intended unwind).
 */
export type ManifestWriteStep = "validate" | "pointer" | "kv";
export type ManifestRemoveStep = "pointer" | "kv";

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

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
 * NOT survive a restart or a redeploy on its own: `purgeSlug` writes the
 * `pending_purges` row that makes it durable before scheduling it.
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
 */
type PurgeLedger = { siteId: string | null } | null;

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
    return await insertPendingPurge({ ...input, siteId: ledger.siteId });
  } catch (err) {
    console.error(
      `[kept] pending_purges row NOT recorded for slug "${input.slug}" — ${message(err)}. URLs: ${input.urls.join(", ")}. Replay this purge by hand if the process restarts (contract §3).`,
    );
    return null;
  }
}

/**
 * Purge both URL forms of a slug, and NEVER throw. By the time this runs the
 * stores already agree; only the edge is stale, and contract §3 is explicit that
 * a failed purge is logged, alerted and retried — not rolled back and not
 * surfaced as a publish failure. A failure leaves a `pending_purges` row due
 * now, which the `repurge` job replays.
 *
 * `ledger.siteId` goes on that row when the caller knows the site: the replay
 * re-runs `syncManifest` for it before purging, so the edge converges on the
 * row as it stands then, not as it stood here.
 */
async function purgeSlug(slug: string, ledger: PurgeLedger): Promise<PurgeResult> {
  let urls: string[];
  try {
    urls = slugPurgeUrls(slug);
  } catch (err) {
    const error = message(err);
    console.error(
      `[kept] purge SKIPPED for slug "${slug}" — ${error}. The stores are correct; the edge may serve a stale copy until this is configured and the purge replayed.`,
    );
    // No URLs to record: the replay derives them from the slug once configured.
    await recordPendingPurge(ledger, { slug, urls: [], dueAt: new Date() });
    return { ok: false, error };
  }

  const result = await purgeUrls(urls);
  if (!result.ok) {
    console.error(
      `[kept] purge FAILED for slug "${slug}" — ${result.error}. URLs: ${urls.join(", ")}. The write succeeded; the edge stays stale until the repurge job replays it (contract §3).`,
    );
    // No in-process re-purge: the first call never reached Cloudflare, so a
    // second on the same broken configuration would only log the same failure
    // twice. The row, due now, is the retry.
    await recordPendingPurge(ledger, { slug, urls, dueAt: new Date() });
    return result;
  }

  // Durable FIRST, then the fast path: a restart between here and the timer
  // leaves a row the `repurge` job replays once it is due.
  const pendingId = await recordPendingPurge(ledger, {
    slug,
    urls,
    dueAt: new Date(Date.now() + KV_REPURGE_DELAY_MS),
  });

  // Floating BY DESIGN — see `repurgeAfterKvPropagation`. A delete must not
  // block for two minutes, and contract §3 forbids a purge from failing the
  // operation it follows. The `.catch` is not decoration: this promise is
  // unawaited, `purgeUrls` re-reads the environment on every call, and an
  // unhandled rejection takes the whole Node process down. A failed re-purge
  // keeps its row, so the job retries it.
  void repurgeAfterKvPropagation(slug, urls)
    .then(async (second) => {
      if (second.ok && pendingId !== null) await deletePendingPurge(pendingId);
    })
    .catch((err: unknown) => {
      console.error(
        `[kept] re-purge THREW for slug "${slug}" — ${message(err)}. The edge may be serving a response re-cached from a stale KV read; the repurge job replays it (contract §6).`,
      );
    });
  return result;
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
  return storeManifest(slug, manifest, { siteId: knownSiteId(manifest.siteId) });
}

async function storeManifest(
  slug: string,
  manifest: KvManifest,
  ledger: PurgeLedger,
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

  return { ok: true, value, purge: await purgeSlug(slug, ledger) };
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
 * `siteId`, when the caller has one, goes on the `pending_purges` row so a
 * replay re-syncs that site (`syncManifest` does). Rename's removal of the OLD
 * name passes none: re-syncing would only rewrite the new one.
 */
export function removeManifest(
  slug: string,
  siteId: string | null = null,
): Promise<ManifestRemoveResult> {
  return unstoreManifest(slug, { siteId });
}

async function unstoreManifest(slug: string, ledger: PurgeLedger): Promise<ManifestRemoveResult> {
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

  return { ok: true, purge: await purgeSlug(slug, ledger) };
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
 * current_version_id, owner_id, region` → `writeManifest` with exactly those
 * values (`live`, `under_review`, `quarantined`, `expired`) or `removeManifest`
 * (`removed`, `archived`) → commit only after KV has answered. Whoever commits a
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
export async function syncManifest(siteId: string): Promise<SyncManifestResult> {
  const synced = await syncSite(siteId, true);
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
  return syncSite(siteId, false);
}

async function syncSite(siteId: string, durable: boolean): Promise<SyncManifestResult> {
  try {
    return await db.transaction(async (tx): Promise<SyncManifestResult> => {
      const site = await lockSiteForSync(tx, siteId);
      if (!site) return { ok: true, outcome: "missing" };
      const ledger: PurgeLedger = durable ? { siteId: site.id } : null;

      if (isUnserved(site.status)) {
        const removed = await unstoreManifest(site.slug, ledger);
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
        },
        ledger,
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
