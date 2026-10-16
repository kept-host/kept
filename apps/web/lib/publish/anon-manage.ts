/**
 * Replace, delete and reminder — everything a publisher can do to a page with
 * nothing but the bearer token they were handed. E04 task 006.
 *
 * NO HTTP IN THIS FILE, same split as `./pipeline`: the three route handlers
 * under `app/api/anon/[anonToken]/` know about `Request` objects and status
 * codes, and these functions know about the stores. That is what lets every
 * drill below run with no server.
 *
 * THE THREE OPERATIONS, AND THE ONE RULE EACH TURNS ON:
 *
 *   replace   R2 object → syncManifest (pointer → KV → purge, from the row
 *             under its lock — D18), same slug, same siteId, NEW versionId. The purge is load-bearing here in a way it
 *             is not on publish: a replaced slug ALWAYS has a cached
 *             predecessor, and `LIVE_CACHE_CONTROL` is a year. Without the
 *             purge the product's most visible behaviour — "I re-dropped my
 *             file and nothing changed" — breaks, and stays broken.
 *
 *   delete    removeManifest(delete pointer → delete KV → purge), then archive
 *             the row (status re-checked under its lock), then syncManifest
 *             (AC42); a flagged page is the uniform 404. POINTER FIRST, NEVER KV FIRST: the Worker probes
 *             `slugs/{slug}.json` exactly when KV cannot answer, so deleting KV
 *             first opens a window in which a miss finds a live pointer and
 *             RESURRECTS A DELETED PAGE. And it is only visible inside that
 *             window — while KV still answers "absent", a backwards delete
 *             passes every test that does not force a miss.
 *
 *   reminder  one column. E04 persists the address; E05 owns the cron that
 *             sends anything to it.
 *
 * WHY THE EDGE IS UNWOUND BEFORE POSTGRES ON DELETE — the mirror image of
 * publish, where Postgres commits first. Publish's dangerous half-state is
 * "bytes with no row"; delete's is "a row that says gone while the page keeps
 * serving". Stopping the serving first makes the worst case a row that still
 * says `live` for a page that no longer serves — visible to an audit, invisible
 * to the internet — instead of the reverse.
 */
import {
  DRAFT_TTL_DAYS,
  hashContent,
  publishRequestSchema,
  type PublishChannel,
  type SiteStatus,
} from "@kept/shared";
import { z } from "zod";

import {
  archiveSite,
  DELETABLE_STATUSES,
  insertReplacementVersion,
  setReminderEmail,
  type AnonSite,
} from "../db/queries/publish";
import { removeManifest, syncManifest } from "../storage/manifest";
import { pageObjectKey } from "../storage/r2";
import { notFound, resolveAnonToken } from "./anon-token";
import { checkReplaceLimit, enqueueScan, verifyTurnstile } from "./hooks";
import { extractPageTitle } from "./page-title";
import {
  fail,
  internalError,
  liveUrl,
  rateLimited,
  requestError,
  writePageAndManifest,
  type PublishFailure,
} from "./pipeline";

/** Success bodies differ per operation; the failure shape never does. */
export type AnonOutcome<T> = { ok: true; status: 200; body: T } | PublishFailure;

/**
 * What a replace returns. Deliberately NOT the publish response: there is no
 * new token (the caller already holds it and echoing a bearer credential back
 * into a body it did not have to be in is a needless copy), and no `deduped`
 * (a replace is an explicit act, never collapsed).
 */
export interface ReplaceResponse {
  live_url: string;
  slug: string;
  /** Unchanged by a replace — see the note on the clock below. */
  expires_in: string | null;
  expires_at: string | null;
}

export interface OkResponse {
  ok: true;
}

/**
 * A replace body is a publish body minus the reminder address — that has its own
 * endpoint, and accepting it here would be a second way to write one column.
 * Reusing the publish schema is what keeps `MAX_PAGE_BYTES`, the HTML check and
 * every error code identical between the two paths.
 */
const replaceRequestSchema = publishRequestSchema.omit({ reminderEmail: true });

/**
 * `""` and `null` both CLEAR the address; anything else must be an email.
 * Presence is required — an absent field would be ambiguous between "clear it"
 * and "leave it alone", and a bearer-token endpoint is the wrong place to guess.
 */
const reminderRequestSchema = z.object({
  reminderEmail: z.union([z.string().email(), z.literal(""), z.null()]),
});

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function draftWindow(site: AnonSite): Pick<ReplaceResponse, "expires_in" | "expires_at"> {
  // `expires_at == null` ⇒ kept, which has no window. `isDraft = expires_at != null`
  // is the derived predicate; there is no draft status to read.
  return site.expiresAt
    ? { expires_in: `${DRAFT_TTL_DAYS}d`, expires_at: site.expiresAt.toISOString() }
    : { expires_in: null, expires_at: null };
}

/**
 * Replace a page's bytes, keeping its URL.
 *
 * ⚠️ THE DRAFT CLOCK IS NOT RESET, AND THAT IS NOT AN OVERSIGHT. `expires_at`
 * and `purge_after` belong to the page, not to its contents. If re-dropping a
 * file restarted the seven days, a weekly `curl` would hold a page forever for
 * free and "keep it" would stop meaning anything. `insertReplacementVersion`
 * touches neither column, and the response echoes the ORIGINAL deadline.
 *
 * `publishedVia` is the route's reading of the transport (`browserChannel` in
 * `./http`): `web` for the app's own manage screen, `api` for everyone else. It
 * lands on the version row only; the response body does not carry it.
 */
export async function replacePage(
  token: string,
  raw: unknown,
  publishedVia: Extract<PublishChannel, "web" | "api">,
): Promise<AnonOutcome<ReplaceResponse>> {
  const site = await resolveAnonToken(token);
  if (!site) return notFound();

  const parsed = replaceRequestSchema.safeParse(raw);
  if (!parsed.success) return requestError(parsed.error);
  const { html, turnstileToken } = parsed.data;

  // The same seams as publish, for the same reason: a replace is a re-publish,
  // and a path that stores new bytes without a governor or the scan enqueue is
  // a hole big enough to publish anything through — publish clean, then
  // replace with the payload. The limit is per page (`anon-replace:<siteId>`).
  if (turnstileToken !== undefined) {
    const turnstile = await verifyTurnstile(turnstileToken);
    if (!turnstile.ok) {
      return fail(403, {
        error: "turnstile_failed",
        message: `The bot check did not pass (${turnstile.reason}). Reload the page and try again.`,
      });
    }
  }

  const limit = await checkReplaceLimit(site.id);
  if (!limit.allowed) return rateLimited(limit);

  const contentHash = await hashContent(html);
  const sizeBytes = Buffer.byteLength(html, "utf8");
  // RE-EXTRACTED, NOT CARRIED OVER. The name belongs to the bytes, so new bytes
  // get a new name — including `null`, when the replacement has no readable
  // `<title>`. Leaving the old value in place would make the dashboard
  // confidently display the PREVIOUS page's name (E06 task 001). An owner-set
  // title survives anyway: `insertReplacementVersion` guards it in SQL (D11).
  const title = extractPageTitle(html);

  // NEW versionId, SAME siteId — so the key is a new object rather than a
  // mutation of one the edge may have cached, and the slug never has to move.
  const versionId = crypto.randomUUID();
  const r2Key = pageObjectKey(site.id, versionId);

  const previous = {
    versionId: site.currentVersionId,
    title: site.title,
    contentHash: site.contentHash,
    sizeBytes: site.sizeBytes,
  };

  try {
    await insertReplacementVersion({
      siteId: site.id,
      versionId,
      r2Key,
      title,
      contentHash,
      sizeBytes,
      publishedVia,
    });
  } catch (err) {
    console.error(
      `[kept] replace: Postgres write failed for site ${site.id} (slug "${site.slug}") — ${message(err)}`,
    );
    return internalError();
  }

  // The manifest is `syncManifest`'s, read from the row under its lock (D18),
  // so a flag that committed after `resolveAnonToken` saw `live` is what the
  // edge serves. A failed write reverts the row to `previous` and syncs again:
  // the page keeps serving what it served before, never dark.
  const stored = await writePageAndManifest({
    slug: site.slug,
    siteId: site.id,
    versionId,
    r2Key,
    html,
    ownerId: site.ownerId,
    previous,
  });

  if (!stored.ok) {
    console.error(
      `[kept] replace: store write failed for site ${site.id} (slug "${site.slug}", object "${r2Key}") — ${stored.error}`,
    );
    return internalError();
  }

  // Fire and forget by contract — the new bytes are already live and a scan must
  // never delay or fail the response.
  void enqueueScan(site.id, versionId, "replace");

  return {
    ok: true,
    status: 200,
    body: {
      live_url: liveUrl(site.slug),
      slug: site.slug,
      ...draftWindow(site),
    },
  };
}

/**
 * Stop serving a page. ARCHIVE, NEVER DESTROY — the bytes and the rows stay and
 * E07's purge does the hard delete against `purge_after`.
 *
 * Only `live` and `expired` pages are deletable (Arun 2026-10-15, decision 2).
 * `under_review`, `quarantined` and `removed` are the uniform 404, exactly like
 * a token that names nothing: a delete would launder the flag, and a different
 * answer would tell a stranger holding a leaked link that the page was flagged.
 *
 * Edge first, then the row under its lock with the status re-checked
 * (`archiveSite`'s guarded `UPDATE`), then — whatever that did — the trailing
 * `syncManifest` (AC42), which puts back the 451 of a flag that committed after
 * the edge came down.
 *
 * Idempotent by construction: the token still resolves after the first call
 * (`requireLive: false`), an already-archived page short-circuits to success,
 * and `removeManifest` is itself safe to repeat because R2 and KV both treat a
 * delete of an absent key as a no-op.
 */
export async function deletePage(token: string): Promise<AnonOutcome<OkResponse>> {
  const site = await resolveAnonToken(token, { requireLive: false });
  if (!site) return notFound();

  if (site.status === "archived") {
    // Already done. A second delete is a success, not a 500 and not a 404 — a
    // retrying agent or a double-clicked button must not see an error for
    // reaching the state it asked for.
    return { ok: true, status: 200, body: { ok: true } };
  }
  if (!isDeletable(site.status)) return notFound();

  // THE EDGE FIRST, AND POINTER-BEFORE-KV INSIDE IT. `removeManifest` owns that
  // ordering; calling `kv.delete` from here would be both a lint error and the
  // resurrection bug.
  const removed = await removeManifest(site.slug, site.id);
  if (!removed.ok) {
    console.error(
      `[kept] delete: manifest removal failed at the "${removed.step}" step for site ${site.id} (slug "${site.slug}") — ${removed.error}. The page is still serving; the row is untouched so the caller can retry.`,
    );
    return internalError();
  }
  // `removed.purge.ok === false` is NOT a failure (contract §3): both stores
  // agree that the slug is gone, and the edge is merely stale until the logged
  // retry lands. `removeManifest` has already logged it.

  let archived: boolean;
  try {
    archived = await archiveSite(site.id);
  } catch (err) {
    console.error(
      `[kept] delete: manifest removed but site ${site.id} (slug "${site.slug}") failed to archive — ${message(err)}. Re-syncing the edge to the row.`,
    );
    await syncDeleted(site.id);
    return internalError();
  }
  await syncDeleted(site.id);
  if (archived) return { ok: true, status: 200, body: { ok: true } };

  // The re-check refused: the row moved between the read and the lock. A
  // concurrent delete that won is still this caller's success; anything else
  // (a flag, a takedown) is the uniform 404.
  const now = await resolveAnonToken(token, { requireLive: false });
  return now?.status === "archived" ? { ok: true, status: 200, body: { ok: true } } : notFound();
}

function isDeletable(status: SiteStatus): boolean {
  return (DELETABLE_STATUSES as readonly SiteStatus[]).includes(status);
}

/** AC42's trailing sync. Never throws; a failure is the repurge job's row. */
async function syncDeleted(siteId: string): Promise<void> {
  const synced = await syncManifest(siteId);
  if (!synced.ok) {
    console.error(
      `[kept] delete: trailing manifest sync failed for site ${siteId} — ${synced.error}. Recorded for the repurge job.`,
    );
  }
}

/**
 * Store or clear the pre-expiry reminder address.
 *
 * The response is the same whether an address was already stored, whether it was
 * overwritten and whether it was cleared. Anything else would let a stranger
 * with a leaked link learn that the publisher left an email address — and the
 * address is the one piece of personal data an anonymous page can carry.
 */
export async function updateReminderEmail(
  token: string,
  raw: unknown,
): Promise<AnonOutcome<OkResponse>> {
  const site = await resolveAnonToken(token);
  if (!site) return notFound();

  const parsed = reminderRequestSchema.safeParse(raw);
  if (!parsed.success) return requestError(parsed.error);

  const email = parsed.data.reminderEmail;
  try {
    await setReminderEmail(site.id, email === "" || email === null ? null : email);
  } catch (err) {
    console.error(
      `[kept] reminder: Postgres write failed for site ${site.id} (slug "${site.slug}") — ${message(err)}`,
    );
    return internalError();
  }

  return { ok: true, status: 200, body: { ok: true } };
}
