/**
 * The browser's client for the owner-scoped (studio) routes — publish, keep,
 * demote, swap, rename, details, replace, restore, delete, bulk keep / delete,
 * and account deletion.
 * Downloads and the export are plain links (`GET`, `Content-Disposition:
 * attachment`); the one read of the download route here is `readPageHtml`, the
 * studio card's hover preview (task 016), which wants the page as text.
 *
 * Same posture as `lib/publish/client.ts`: this module knows the endpoint's URL
 * and nothing else. It serializes the request the route already accepts, parses
 * the response with the SAME `@kept/shared` schemas the route answers with, and
 * hands back a discriminated result. No retries, no state, no DOM.
 *
 * ── ONE ERROR SHAPE IN, ONE ERROR SHAPE OUT (E06 task 005) ─────────────────
 * Every studio refusal arrives as the envelope `{ error: { code, message } }`
 * and is handed to the caller as its inner `StudioError` — `code` to branch on,
 * `message` to show verbatim. ANYTHING ELSE — a network failure, a proxy's HTML
 * 502, E05a's origin 403 (which keeps its own flat body on purpose), a success
 * body that does not parse — becomes `COULD_NOT_SAVE`, "Couldn't save. Try
 * again." A caller never sees a half-parsed body or a second error shape.
 *
 * ⚠️ BROWSER-SAFE ON PURPOSE. Nothing here may import `lib/names/*` (other than
 * the pure `messages.ts`), `lib/db/*` or `lib/storage/*` — those reach
 * Postgres, R2 and KV. The name rule is the server's: the field asks
 * `GET /api/names/check` rather than re-running a lookalike.
 */
import {
  accountDeletionResultSchema,
  bulkResultSchema,
  deleteResultSchema,
  demoteResultSchema,
  keepResultSchema,
  nameChangeResultSchema,
  nameCheckResultSchema,
  ownedPublishResultSchema,
  replaceResultSchema,
  restoreResultSchema,
  siteUpdateResultSchema,
  studioErrorSchema,
  swapResultSchema,
  type AccountDeletionRequest,
  type AccountDeletionResult,
  type BulkAction,
  type BulkItemResult,
  type DeleteResult,
  type DemoteResult,
  type KeepResult,
  type NameChangeRequest,
  type NameCheckResult,
  type OwnedPublishResult,
  type PublishRequest,
  type ReplaceResult,
  type RestoreResult,
  type SiteUpdateRequest,
  type StudioError,
  type StudioSite,
  type SwapResult,
} from "@kept/shared";
import type { z } from "zod";

import { pageDownloadHref } from "./display";

/**
 * What every failure that is NOT the studio envelope becomes — the epic's one
 * generic sentence. `internal_error` because nothing the caller can branch on
 * is known about it.
 */
export const COULD_NOT_SAVE: StudioError = {
  code: "internal_error",
  message: "Couldn't save. Try again.",
};

/** What `send` hands back: the parsed success body, or the error to show. */
type Sent<T> =
  | { ok: true; body: T }
  | { ok: false; status: number | null; error: StudioError };

/**
 * The one request path every call below takes. Never throws, including on
 * abort.
 *
 * `accepted` are the success statuses this endpoint answers with; their body
 * must parse as `schema` or the call is `COULD_NOT_SAVE`. Any other status is
 * read as the envelope — the handler's own `code` and sentence — and anything
 * that is not the envelope is `COULD_NOT_SAVE`. `status` rides along on a
 * failure for the one caller that branches on it (`deleteAccount`'s 401);
 * `null` means the request never got an answer.
 */
async function send<T>(
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
  accepted: readonly number[] = [200],
): Promise<Sent<T>> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    return { ok: false, status: null, error: COULD_NOT_SAVE };
  }

  const json: unknown = await response.json().catch(() => null);

  if (!accepted.includes(response.status)) {
    const envelope = studioErrorSchema.safeParse(json);
    return {
      ok: false,
      status: response.status,
      error: envelope.success ? envelope.data.error : COULD_NOT_SAVE,
    };
  }

  const parsed = schema.safeParse(json);
  return parsed.success
    ? { ok: true, body: parsed.data }
    : { ok: false, status: response.status, error: COULD_NOT_SAVE };
}

/**
 * A page's current HTML, for the card's hover preview — the owner-only
 * `GET /api/sites/:id/download` read as text. `null` on any failure, an abort
 * included: a preview is worth zero errors, and the card simply stays a card.
 */
export async function readPageHtml(siteId: string, signal: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(pageDownloadHref(siteId), { signal });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

/** A JSON request body, with the header the routes read it by. */
function jsonInit(method: string, body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  };
}

/** An owned publish: the page the account now has, or why it never landed. */
export type OwnedPublishOutcome =
  | { ok: true; page: OwnedPublishResult }
  | { ok: false; error: StudioError };

/** A rename attempt: the renamed page, or an error from the closed enum. */
export type RenameOutcome =
  | { ok: true; site: StudioSite }
  | { ok: false; error: StudioError };

/** A name check: the status and its numbers, or why there is no answer. */
export type NameCheckOutcome =
  | { ok: true; result: NameCheckResult }
  | { ok: false; error: StudioError };

/**
 * What to tell someone who just renamed a page — PRD §5.4's toast,
 * `{new}.{base}` read off the `liveUrl` the server built from configuration.
 */
export function renameNotice(site: Pick<StudioSite, "liveUrl">): string {
  return `Renamed. Your page is at ${new URL(site.liveUrl).host}.`;
}

/**
 * `POST /api/sites` — a signed-in publish, from the dashboard drop-zone.
 *
 * ⚠️ NOT `POST /api/publish`, AND THE TWO MUST NEVER BE SWAPPED HERE. That route
 * is the keyless one: it mints an anonymous bearer token, leaves `owner_id` null
 * and starts a clock. Sending a signed-in user down it hands their browser a
 * second authority for a page their account already owns, and routes them
 * through the endpoint E07's volume governors exist to throttle. Decision
 * **D9**: one product verb, two authority models, two doors.
 *
 * ⚠️ BEING AT THE CAP IS NOT AN ERROR. A new page is **201** either way: kept
 * under the plan's limit, an owned draft at it — `page.site.expiresAt` set, the
 * page live and its countdown already running. **200 with `duplicate: true`**
 * means this account already has these exact bytes live and `page.site` is that
 * page; nothing new was made. `ok: false` here means the request genuinely did
 * not land.
 *
 * `application/json` with `{ html }`, like every other browser caller; the route
 * accepts multipart and raw `text/html` for callers that cannot build JSON.
 *
 * Never throws, including on abort.
 */
export async function publishOwnedHtml(
  html: string,
  signal?: AbortSignal,
): Promise<OwnedPublishOutcome> {
  const body: Pick<PublishRequest, "html"> = { html };
  const sent = await send(
    "/api/sites",
    jsonInit("POST", body, signal),
    ownedPublishResultSchema,
    [200, 201],
  );
  return sent.ok ? { ok: true, page: sent.body } : { ok: false, error: sent.error };
}

/**
 * `PATCH /api/sites/:id/name` — rename a kept page (PRD §5.4).
 *
 * The page's address moves, so the caller repaints from `site` — its `slug`,
 * `liveUrl` and `updatedAt` are the server's. Every refusal arrives with the
 * field's own sentence; a name taken since the last check is `name_taken`.
 *
 * Never throws, including on abort.
 */
export async function renamePage(
  siteId: string,
  name: string,
  signal?: AbortSignal,
): Promise<RenameOutcome> {
  const body: NameChangeRequest = { name };
  const sent = await send(
    `/api/sites/${encodeURIComponent(siteId)}/name`,
    jsonInit("PATCH", body, signal),
    nameChangeResultSchema,
  );
  return sent.ok ? { ok: true, site: sent.body.site } : { ok: false, error: sent.error };
}

/** A Details save: the page as it now is, or why nothing changed. */
export type UpdateOutcome =
  | { ok: true; site: StudioSite }
  | { ok: false; error: StudioError };

/**
 * `PATCH /api/sites/:id` — save a page's title and/or Explore flag (PRD §5.2).
 *
 * Send only what changed. `title: ""` hands the title back to the page's own
 * `<title>`, so the caller repaints from `site.title` rather than from what it
 * sent. A refusal is the envelope's own sentence; anything else is
 * `COULD_NOT_SAVE`.
 *
 * Never throws, including on abort.
 */
export async function updatePage(
  siteId: string,
  update: SiteUpdateRequest,
  signal?: AbortSignal,
): Promise<UpdateOutcome> {
  const sent = await send(
    `/api/sites/${encodeURIComponent(siteId)}`,
    jsonInit("PATCH", update, signal),
    siteUpdateResultSchema,
  );
  return sent.ok ? { ok: true, site: sent.body.site } : { ok: false, error: sent.error };
}

/**
 * `GET /api/names/check` — what the server would say about `name` for this page
 * right now. ADVISORY: the rename re-asks under its locks, so a field may show
 * it but must never treat it as permission. `nameStatusMessage`
 * (`lib/names/messages.ts`) turns the result into the field's sentence.
 *
 * Never throws, including on abort.
 */
export async function checkName(
  siteId: string,
  name: string,
  signal?: AbortSignal,
): Promise<NameCheckOutcome> {
  const query = new URLSearchParams({ name, siteId });
  const sent = await send(`/api/names/check?${query}`, { signal }, nameCheckResultSchema);
  return sent.ok ? { ok: true, result: sent.body } : { ok: false, error: sent.error };
}

/** A keep attempt: the parsed outcome, or an error from the closed enum. */
export type KeepOutcome =
  | { ok: true; result: KeepResult }
  | { ok: false; error: StudioError };

/**
 * `POST /api/sites/:id/keep` — E06 task 007.
 *
 * ⚠️ BEING AT THE CAP IS NOT A FAILURE TO SHOW. The route answers
 * `409 at_kept_limit` when the account is full (E06 task 004): nothing was
 * written, the page keeps its clock, and the caller's job is to offer the swap
 * chooser on that code, not to print it as an error.
 *
 * The caller normally knows it is at the cap before clicking and opens the
 * chooser without asking — that code is the race where a slot filled up in
 * another tab between the render and the click, and the server's refusal is the
 * authority that settles it.
 *
 * Never throws, including on abort.
 */
export async function keepPage(
  siteId: string,
  signal?: AbortSignal,
): Promise<KeepOutcome> {
  const sent = await send(
    `/api/sites/${encodeURIComponent(siteId)}/keep`,
    { method: "POST", signal },
    keepResultSchema,
  );
  return sent.ok ? { ok: true, result: sent.body } : { ok: false, error: sent.error };
}

/** A demote attempt: the page and its fresh clock, or why nothing moved. */
export type DemoteOutcome =
  | { ok: true; result: DemoteResult }
  | { ok: false; error: StudioError };

/**
 * `POST /api/sites/:id/demote` — an owner puts a kept page back on a clock.
 *
 * ⚠️ THE WARNING BELONGS TO THE CALLER AND MUST ALREADY HAVE BEEN SHOWN. This
 * function asks nothing. `demoteConsequence` in `lib/sites/display.ts` is the
 * sentence, and the route says the same thing from its own side: nothing is
 * removed, but the page acquires a fresh `DRAFT_TTL_DAYS` deadline and will
 * expire unless it is kept again.
 *
 * There is no `owned_draft`-style branch here: demote always succeeds on a page
 * that can be demoted, which is why `DemoteResult` carries no discriminant. The
 * response's `quota` is the freed slot, so the screen repaints its allowance
 * from this body rather than refetching to learn what it just caused.
 *
 * Never throws, including on abort.
 */
export async function demotePage(
  siteId: string,
  signal?: AbortSignal,
): Promise<DemoteOutcome> {
  const sent = await send(
    `/api/sites/${encodeURIComponent(siteId)}/demote`,
    { method: "POST", signal },
    demoteResultSchema,
  );
  return sent.ok ? { ok: true, result: sent.body } : { ok: false, error: sent.error };
}

/** A swap attempt: both halves of the transaction, or the reason there were none. */
export type SwapOutcome =
  | { ok: true; result: SwapResult }
  | { ok: false; error: StudioError };

/**
 * `POST /api/sites/swap` — demote one kept page and keep another, atomically.
 *
 * ⚠️ ONE REQUEST, AND THE UI ADDS NO SECOND ATOMICITY MECHANISM. `swapKept`
 * runs both writes in a single Postgres transaction, so there is nothing here to
 * retry, compensate or sequence — a caller that sent a demote and then a keep
 * would be re-implementing the one property this endpoint exists to guarantee,
 * badly, with a window in the middle where the account is a page short.
 *
 * The response carries BOTH halves and a post-swap `KeptQuota` on each, which is
 * why the chooser needs no refetch: everything the two cards and the header have
 * to say next is in this body, already agreed with the database.
 *
 * `demote === keep` is refused by the route with the only 400 this family emits.
 * The chooser cannot construct it — the page being kept is not in the candidate
 * list — so if that message arrives it is a real disagreement about state and is
 * surfaced, never swallowed.
 *
 * The body is typed inline rather than imported: `swapRequestSchema` lives in
 * `lib/sites/owner-routes.ts`, which reaches Postgres, and this module is
 * browser-safe on purpose (see the header).
 *
 * Never throws, including on abort.
 */
export async function swapPages(
  demote: string,
  keep: string,
  signal?: AbortSignal,
): Promise<SwapOutcome> {
  const body: { demote: string; keep: string } = { demote, keep };
  const sent = await send("/api/sites/swap", jsonInit("POST", body, signal), swapResultSchema);
  return sent.ok ? { ok: true, result: sent.body } : { ok: false, error: sent.error };
}

/**
 * A replace attempt: the page with its new version — or `page.unchanged` when the
 * file was the one already served — or why it did not land.
 */
export type ReplaceOutcome =
  | { ok: true; page: ReplaceResult }
  | { ok: false; error: StudioError };

/**
 * What to tell someone who just replaced a page's file — E06 task 006.
 *
 * ⚠️ THE ADDRESS DID NOT MOVE AND THE CLOCK DID NOT RESET, and both of those are
 * things a person reasonably expects to have happened. Saying them out loud is
 * cheaper than the support question. The `DRAFT_TTL_DAYS` half of it is
 * `REPLACE_CLOCK_NOTE` in `components/kept/draft-chip.tsx`, which composes the
 * number from `@kept/shared`; this sentence deliberately does not restate it,
 * because two copies of the same promise drift.
 *
 * The propagation caveat is the same fact of the architecture the rename copy
 * accommodates: `writeManifest` purges immediately, but the Worker may answer a
 * cache MISS from a KV read it made up to `MANIFEST_KV_CACHE_TTL_SECONDS` ago
 * and rebuild a response from the previous manifest. That tail is what the
 * delayed second purge ends (`KV_REPURGE_DELAY_MS`, about two minutes). In
 * practice it is seconds — do not "tighten" this to an instant swap.
 */
export function replaceNotice(page: ReplaceResult): string {
  // PRD §5.5's sentence for re-dropping the file already served (AC27).
  if (page.unchanged) return "No changes — that's already the live version.";
  return `The new file is live at ${page.liveUrl} — same address, nothing to re-share. A browser that already had the old version open may keep showing it for a minute or two; a reload past that always gets the new one.`;
}

/**
 * `POST /api/sites/:id/replace` — swap a page's bytes, keeping its URL.
 *
 * `application/json` with `{ html }`: the route accepts multipart and raw
 * `text/html` too, for callers that cannot build JSON, which a browser can. The
 * file has already been read to a string by the caller — a drop target reads it
 * once, and handing a `File` down here would make this module know about the DOM
 * it is deliberately kept away from.
 *
 * `page.unchanged` means the bytes were identical to the served version and
 * nothing was written. Otherwise `page.previousVersionId` is what an Undo hands
 * to `restoreVersion`, and `page.pruned` says the plan's version limit dropped
 * the oldest one.
 *
 * ⚠️ THE PRE-FLIGHT IS THE CALLER'S. `checkPageFile` / `checkPageHtml` in
 * `lib/publish/client.ts` are the courtesy checks that catch an obviously-wrong
 * file in a millisecond; they share `MAX_PAGE_BYTES` with the server, which
 * validates every byte again and is the only authority.
 *
 * Never throws, including on abort.
 */
export async function replacePage(
  siteId: string,
  html: string,
  signal?: AbortSignal,
): Promise<ReplaceOutcome> {
  const body: Pick<PublishRequest, "html"> = { html };
  const sent = await send(
    `/api/sites/${encodeURIComponent(siteId)}/replace`,
    jsonInit("POST", body, signal),
    replaceResultSchema,
  );
  return sent.ok ? { ok: true, page: sent.body } : { ok: false, error: sent.error };
}

/** A restore attempt: the version now served (or `unchanged`), or why not. */
export type RestoreOutcome =
  | { ok: true; result: RestoreResult }
  | { ok: false; error: StudioError };

/**
 * `POST /api/sites/:id/versions/:versionId/restore` — serve an older version
 * again. Also the Undo after a replace: pass the replace's `previousVersionId`.
 *
 * No bytes travel: the version is already stored, and the server only moves the
 * pointer. `result.unchanged` means that version was already the served one; a
 * version that is not this page's (or was pruned) is `version_not_found`.
 *
 * Never throws, including on abort.
 */
export async function restoreVersion(
  siteId: string,
  versionId: string,
  signal?: AbortSignal,
): Promise<RestoreOutcome> {
  const sent = await send(
    `/api/sites/${encodeURIComponent(siteId)}/versions/${encodeURIComponent(versionId)}/restore`,
    { method: "POST", signal },
    restoreResultSchema,
  );
  return sent.ok ? { ok: true, result: sent.body } : { ok: false, error: sent.error };
}

/** A delete attempt: the archived page and the freed slot, or the failure. */
export type DeleteOutcome =
  | { ok: true; result: DeleteResult }
  | { ok: false; error: StudioError };

/**
 * `DELETE /api/sites/:id` — take one page off the internet.
 *
 * ⚠️ THE CONFIRMATION IS THE CALLER'S. This function asks nothing and warns
 * about nothing; by the time it runs, the decision has been made. The surface
 * that calls it owns the dialog, and `DELETE_GRACE_NOTE` in
 * `components/kept/draft-chip.tsx` is the sentence that tells the truth about
 * what survives — the page stops serving now, the bytes are collected later.
 *
 * The response carries the post-delete `KeptQuota`, so a dashboard repaints
 * "Kept · N of {limit}" from this body rather than refetching to discover the
 * slot it already knows it freed.
 *
 * Never throws, including on abort.
 */
export async function deletePage(
  siteId: string,
  signal?: AbortSignal,
): Promise<DeleteOutcome> {
  const sent = await send(
    `/api/sites/${encodeURIComponent(siteId)}`,
    { method: "DELETE", signal },
    deleteResultSchema,
  );
  return sent.ok ? { ok: true, result: sent.body } : { ok: false, error: sent.error };
}

/** A bulk keep / delete: one result per page, or why nothing was done at all. */
export type BulkOutcome =
  | { ok: true; results: BulkItemResult[] }
  | { ok: false; error: StudioError };

/**
 * `POST /api/sites/bulk` — keep or delete many pages in one request.
 *
 * ⚠️ SUCCESS IS PER PAGE. `ok: true` means the request was answered; each of
 * `results` says whether ITS page was kept or deleted, with the single route's
 * code and sentence when it was not. The one whole-request refusal is a keep
 * past the free kept slots (`at_kept_limit`): nothing was kept.
 *
 * Delete's confirmation is the caller's, as `deletePage`'s is. Never throws,
 * including on abort.
 */
export async function bulkPages(
  action: BulkAction,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<BulkOutcome> {
  const sent = await send("/api/sites/bulk", jsonInit("POST", { action, ids }, signal), bulkResultSchema);
  return sent.ok ? { ok: true, results: sent.body.results } : { ok: false, error: sent.error };
}

/**
 * An account deletion: how many pages went offline, or why nothing changed.
 *
 * `signedOut` is its own branch rather than a message, because the only useful
 * response to it is a navigation to sign-in — printing "Sign in to manage this
 * page" inside a dialog on a screen that already rendered a session would read
 * as a bug.
 */
export type AccountDeletionOutcome =
  | { ok: true; result: AccountDeletionResult }
  | { ok: false; signedOut: true }
  | { ok: false; signedOut?: false; error: StudioError };

/**
 * `DELETE /api/account` — a signed-in user deletes their own account (D16).
 *
 * ⚠️ THE TYPED EMAIL IS THE REQUEST, NOT MERELY THE UI'S GATE. The route checks
 * `email` against the session's own address (`confirmsAccountEmail`), so a stray
 * `fetch("/api/account", { method: "DELETE" })` from this app's own origin
 * cannot delete an account by arriving. The caller passes what the person
 * actually typed; a mismatch is refused by the server, not smoothed over here.
 *
 * ⚠️ NO PATH SEGMENT NAMING A VICTIM, EVER. The route resolves the account from
 * the session.
 *
 * On success the route has already cleared the session cookie; the caller
 * navigates to the apex. The refusals arrive as the studio envelope with the
 * server's own sentence, shown verbatim:
 *   · 400 — the email did not match
 *   · 401 — the session is gone (its own branch above)
 *   · 503 — a page could not be taken off the edge, so **nothing** was deleted
 * A foreign-origin 403 is not the envelope, so it reads as `COULD_NOT_SAVE`.
 *
 * Never throws, including on abort.
 */
export async function deleteAccount(
  { email }: AccountDeletionRequest,
  signal?: AbortSignal,
): Promise<AccountDeletionOutcome> {
  const sent = await send(
    "/api/account",
    jsonInit("DELETE", { email }, signal),
    accountDeletionResultSchema,
  );
  if (sent.ok) return { ok: true, result: sent.body };
  if (sent.status === 401) return { ok: false, signedOut: true };
  return { ok: false, error: sent.error };
}
