/**
 * Replace, delete and reminder — everything a publisher can do to a page with
 * nothing but the bearer token they were handed. E04 task 006.
 *
 * NO HTTP IN THIS FILE, same split as `./pipeline`: the three route handlers
 * under `app/api/sites/[anonToken]/` know about `Request` objects and status
 * codes, and these functions know about the stores. That is what lets every
 * drill below run with no server.
 *
 * THE THREE OPERATIONS, AND THE ONE RULE EACH TURNS ON:
 *
 *   replace   R2 object → writeManifest(pointer → KV → purge), same slug, same
 *             siteId, NEW versionId. The purge is load-bearing here in a way it
 *             is not on publish: a replaced slug ALWAYS has a cached
 *             predecessor, and `LIVE_CACHE_CONTROL` is a year. Without the
 *             purge the product's most visible behaviour — "I re-dropped my
 *             file and nothing changed" — breaks, and stays broken.
 *
 *   delete    removeManifest(delete pointer → delete KV → purge), then archive
 *             the row. POINTER FIRST, NEVER KV FIRST: the Worker probes
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
import { DRAFT_TTL_DAYS, hashContent, publishRequestSchema } from "@kept/shared";
import { z } from "zod";

import {
  archiveSite,
  insertReplacementVersion,
  revertReplacementVersion,
  setReminderEmail,
  type AnonSite,
} from "../db/queries/publish";
import { removeManifest } from "../storage/manifest";
import { pageObjectKey } from "../storage/r2";
import { notFound, resolveAnonToken } from "./anon-token";
import { checkHeuristics, enqueueScan, verifyTurnstile } from "./hooks";
import {
  fail,
  internalError,
  liveUrl,
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
 */
export async function replacePage(
  token: string,
  raw: unknown,
): Promise<AnonOutcome<ReplaceResponse>> {
  const site = await resolveAnonToken(token);
  if (!site) return notFound();

  const parsed = replaceRequestSchema.safeParse(raw);
  if (!parsed.success) return requestError(parsed.error);
  const { html, turnstileToken } = parsed.data;

  // The same seams as publish, for the same reason: a replace is a re-publish,
  // and a path that stores new bytes without the content check or the scan
  // enqueue is a hole big enough to publish anything through — publish clean,
  // then replace with the payload.
  if (turnstileToken !== undefined) {
    const turnstile = await verifyTurnstile(turnstileToken);
    if (!turnstile.ok) {
      return fail(403, {
        error: "turnstile_failed",
        message: `The bot check did not pass (${turnstile.reason}). Reload the page and try again.`,
      });
    }
  }

  const heuristics = await checkHeuristics(html);
  if (!heuristics.allowed) {
    return fail(422, {
      error: "content_rejected",
      message: `This page was refused by the content check (${heuristics.reason}).`,
    });
  }

  const contentHash = await hashContent(html);
  const sizeBytes = Buffer.byteLength(html, "utf8");

  // NEW versionId, SAME siteId — so the key is a new object rather than a
  // mutation of one the edge may have cached, and the slug never has to move.
  const versionId = crypto.randomUUID();
  const r2Key = pageObjectKey(site.id, versionId);

  const previous = {
    versionId: site.currentVersionId,
    contentHash: site.contentHash,
    sizeBytes: site.sizeBytes,
  };

  try {
    await insertReplacementVersion({
      siteId: site.id,
      versionId,
      r2Key,
      contentHash,
      sizeBytes,
    });
  } catch (err) {
    console.error(
      `[kept] replace: Postgres write failed for site ${site.id} (slug "${site.slug}") — ${message(err)}`,
    );
    return internalError();
  }

  const stored = await writePageAndManifest({
    slug: site.slug,
    siteId: site.id,
    versionId,
    r2Key,
    html,
    ownerId: site.ownerId,
    // The unwind restores this version's manifest rather than removing it: a
    // failed replace must leave the page serving what it served before, never
    // dark.
    previousVersionId: previous.versionId ?? undefined,
  });

  if (!stored.ok) {
    console.error(
      `[kept] replace: store write failed for site ${site.id} (slug "${site.slug}", object "${r2Key}") — ${stored.error}`,
    );
    try {
      await revertReplacementVersion({ siteId: site.id, versionId, previous });
    } catch (err) {
      console.error(
        `[kept] ROLLBACK INCOMPLETE — site ${site.id} (slug "${site.slug}") still points at version ${versionId}: ${message(err)}. E07 DIVERGENCE AUDIT: Postgres is the authority, never an R2 list (contract §7.5).`,
      );
    }
    return internalError();
  }

  // Fire and forget by contract — the new bytes are already live and a scan must
  // never delay or fail the response.
  void enqueueScan(site.id, versionId);

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
 * E07's grace-end job does the hard delete against `purge_after`.
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

  // THE EDGE FIRST, AND POINTER-BEFORE-KV INSIDE IT. `removeManifest` owns that
  // ordering; calling `kv.delete` from here would be both a lint error and the
  // resurrection bug.
  const removed = await removeManifest(site.slug);
  if (!removed.ok) {
    console.error(
      `[kept] delete: manifest removal failed at the "${removed.step}" step for site ${site.id} (slug "${site.slug}") — ${removed.error}. The page is still serving; the row is untouched so the caller can retry.`,
    );
    return internalError();
  }
  // `removed.purge.ok === false` is NOT a failure (contract §3): both stores
  // agree that the slug is gone, and the edge is merely stale until the logged
  // retry lands. `removeManifest` has already logged it.

  try {
    await archiveSite(site.id);
  } catch (err) {
    // The page has already stopped serving, which is what the caller asked for,
    // but the row still says `live`. Loud, because only an audit can see it.
    console.error(
      `[kept] delete: manifest removed but site ${site.id} (slug "${site.slug}") failed to archive — ${message(err)}. The page is NOT serving; the row disagrees. E07 DIVERGENCE AUDIT: reconcile against Postgres (contract §7.5).`,
    );
    return internalError();
  }

  return { ok: true, status: 200, body: { ok: true } };
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
