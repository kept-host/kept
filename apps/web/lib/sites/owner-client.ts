/**
 * The browser's client for the owner-scoped management routes — rename (task
 * 005), replace and delete (task 006).
 *
 * Same posture as `lib/publish/client.ts`: this module knows the endpoint's URL
 * and nothing else. It serializes the request the route already accepts, parses
 * the response with the SAME `@kept/shared` schemas the route answers with, and
 * hands back a discriminated result. No retries, no state, no DOM.
 *
 * ⚠️ BROWSER-SAFE ON PURPOSE. Nothing here may import `lib/sites/rename.ts`,
 * `lib/db/*` or `lib/storage/*` — those reach Postgres, R2 and KV. The one
 * validation rule it shares with the server comes from `lib/publish/slug.ts`,
 * which is pure by design precisely so this file can call it.
 */
import {
  accountDeletionResultSchema,
  deleteResultSchema,
  demoteResultSchema,
  keepResultSchema,
  MANIFEST_KV_CACHE_TTL_SECONDS,
  ownedPublishResultSchema,
  publishErrorSchema,
  renameResultSchema,
  replaceResultSchema,
  swapResultSchema,
  type AccountDeletionResult,
  type DeleteResult,
  type DemoteResult,
  type KeepResult,
  type OwnedPublishResult,
  type PublishError,
  type PublishRequest,
  type RenameRequest,
  type RenameResult,
  type ReplaceResult,
  type SwapResult,
} from "@kept/shared";

export { checkChosenSlug, type SlugRefusal, type SlugRefusalReason } from "../publish/slug";

/** An owned publish: the page the account now has, or why it never landed. */
export type OwnedPublishOutcome =
  | { ok: true; page: OwnedPublishResult }
  | { ok: false; error: PublishError };

/** A rename attempt: the moved page, or an error from the closed enum. */
export type RenameOutcome =
  | { ok: true; page: RenameResult }
  | { ok: false; error: PublishError };

const SECONDS_PER_MINUTE = 60;

/**
 * How long the edge can still answer from the state a write just replaced, in
 * whole minutes — the old address after a rename, the old bytes after a replace.
 *
 * Derived, never typed as a literal: it is the same
 * `2 × MANIFEST_KV_CACHE_TTL_SECONDS + 5 s` that `lib/storage/manifest.ts`
 * sizes its second purge from. Past that point the re-purge has run and the
 * edge cannot be holding a response built from the pre-write manifest.
 */
const STALE_EDGE_MINUTES = Math.round(
  (2 * MANIFEST_KV_CACHE_TTL_SECONDS + 5) / SECONDS_PER_MINUTE,
);

/**
 * What to tell someone who just renamed a page.
 *
 * ⚠️ THE OLD URL DOES NOT 404 IMMEDIATELY AND THIS SENTENCE MUST NOT SAY IT
 * DOES. The Worker reads KV with `cacheTtl: MANIFEST_KV_CACHE_TTL_SECONDS` (60,
 * already Cloudflare's floor) and `purge_cache` does not reach that layer, so
 * "live at the new URL, old URL 404s instantly" is not achievable and never was
 * — epic decision D2 says so in as many words.
 *
 * MEASURED, not calculated — dev stack, 2026-08-22, with the repo's own
 * `writeManifest`/`removeManifest` against the deployed Worker:
 *
 *   · a page warmed for 90 s (Cache API `HIT`, `age` climbing to 86) stopped
 *     serving **4 seconds** after `removeManifest` returned;
 *   · a page one second old stopped serving in **1 second**;
 *   · neither run reproduced the re-cached-from-a-stale-KV-read tail that
 *     `manifest.ts` documents from 2026-08-05, because a Cache API HIT never
 *     re-reads KV — that tail needs a cache miss landing inside the 60 s
 *     window, and the delayed second purge is what ends it.
 *
 * So the truthful shape of the sentence is: it is over in seconds in practice,
 * bounded by `STALE_EDGE_MINUTES` in the worst case, and **nobody is dropped in
 * the meantime** — both slugs resolve to the same page while the old one lives,
 * which is exactly why the rename writes the new manifest before removing the
 * old one. Do not "tighten" this to an instant cutover.
 */
export function renameNotice(page: RenameResult): string {
  if (page.previousSlug === page.slug) {
    return "That is already this page's address — nothing changed.";
  }
  return `Your page is live at ${page.liveUrl}. The old address keeps working for up to about ${STALE_EDGE_MINUTES} minutes and then stops, so nobody following an old link is dropped in the meantime.`;
}

/**
 * Turn a non-200 into a `PublishError`, falling back for non-handler responses.
 *
 * ⚠️ THE HANDLER'S OWN MESSAGE WINS WHENEVER THERE IS ONE, and that is what
 * carries the `demote === keep` 400 — the only 400 the owner routes emit —
 * through to the screen instead of being flattened into a generic failure. The
 * fallback exists for the responses no handler wrote: a proxy's 502, an HTML
 * error page, a body that is not JSON at all.
 *
 * `verb` names the action in that fallback only, so "kept couldn't swap the
 * pages" is never printed over a rename.
 */
async function readError(response: Response, verb: string): Promise<PublishError> {
  const parsed = publishErrorSchema.safeParse(await response.json().catch(() => null));
  if (parsed.success) return parsed.data;
  return {
    error: "internal_error",
    message: `kept couldn't ${verb} (HTTP ${response.status}). Nothing changed — try again.`,
  };
}

/** The one sentence for a request that never reached the control plane. */
function unreachable(verb: string): PublishError {
  return {
    error: "internal_error",
    message: `kept couldn't be reached, so nothing was ${verb}. Check your connection and try again.`,
  };
}

/**
 * `POST /api/sites` — a signed-in publish, from the dashboard drop-zone.
 *
 * ⚠️ NOT `POST /api/publish`, AND THE TWO MUST NEVER BE SWAPPED HERE. That route
 * is the keyless one: it mints an anonymous bearer token, leaves `owner_id` null
 * and starts a clock. Sending a signed-in user down it hands their browser a
 * second authority for a page their account already owns, and routes them
 * through the endpoint E07's volume governors exist to throttle. Epic decision
 * **D1**: one product verb, two authority models, two doors.
 *
 * ⚠️ BEING AT THE CAP IS NOT AN ERROR. The route answers **200** either way and
 * the branch is on `outcome`, never on the status code — `kept` under the cap,
 * `owned_draft` at it, with the page live and its countdown already running. A
 * caller that treated `owned_draft` as a failure would be showing an error for a
 * page that published perfectly, which is the one thing the cap branch exists to
 * prevent. `ok: false` here means the request genuinely did not land.
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
  let response: Response;
  try {
    response = await fetch("/api/sites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    return { ok: false, error: unreachable("published") };
  }

  if (response.status !== 200) {
    return { ok: false, error: await readError(response, "publish the page") };
  }

  const parsed = ownedPublishResultSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        error: "internal_error",
        message:
          "kept answered with something this page could not read. Reload to see whether the page was published.",
      },
    };
  }
  return { ok: true, page: parsed.data };
}

/**
 * `PATCH /api/sites/:id/slug`.
 *
 * ⚠️ THE CALLER MUST NAVIGATE. `/site/[slug]` is keyed by slug, so on success
 * the client has to `router.replace` onto `page.slug` — otherwise the user's
 * next navigation 404s on their own page. That is why the response carries it.
 *
 * The slug is checked locally first (`checkChosenSlug`) only to save a round
 * trip on an obviously-wrong name; the server runs the identical function and
 * is the only authority — and availability is not checked here AT ALL, because
 * `sites_slug_key` is the only thing that can answer it. A "taken" answer
 * arrives as a 409 from this call, never from a pre-flight probe.
 *
 * Never throws, including on abort.
 */
export async function renamePage(
  siteId: string,
  slug: string,
  signal?: AbortSignal,
): Promise<RenameOutcome> {
  const body: RenameRequest = { slug };
  let response: Response;
  try {
    response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/slug`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    return { ok: false, error: unreachable("renamed") };
  }

  if (response.status !== 200) {
    return { ok: false, error: await readError(response, "rename the page") };
  }

  const parsed = renameResultSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        error: "internal_error",
        message: "kept answered with something this page could not read. Reload to see where your page ended up.",
      },
    };
  }
  return { ok: true, page: parsed.data };
}

/** A keep attempt: the parsed outcome, or an error from the closed enum. */
export type KeepOutcome =
  | { ok: true; result: KeepResult }
  | { ok: false; error: PublishError };

/**
 * `POST /api/sites/:id/keep` — E06 task 007.
 *
 * ⚠️ BEING AT THE CAP IS NOT AN ERROR AND MUST NOT BE READ AS ONE. The route
 * answers HTTP 200 with `outcome: "owned_draft"` when the account is full; the
 * page keeps its clock and its countdown and the caller's job is to offer the
 * swap chooser, not to show a failure. `ok: false` here means the request
 * genuinely did not land.
 *
 * The caller normally knows it is at the cap before clicking and opens the
 * chooser without asking — this branch is the race where a slot filled up in
 * another tab between the render and the click, and the fresh `quota` on the
 * response is the authority that settles it.
 *
 * Never throws, including on abort.
 */
export async function keepPage(
  siteId: string,
  signal?: AbortSignal,
): Promise<KeepOutcome> {
  let response: Response;
  try {
    response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/keep`, {
      method: "POST",
      signal,
    });
  } catch {
    return { ok: false, error: unreachable("kept") };
  }

  if (response.status !== 200) {
    return { ok: false, error: await readError(response, "keep the page") };
  }

  const parsed = keepResultSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        error: "internal_error",
        message:
          "kept answered with something this page could not read. Reload to see whether the page was kept.",
      },
    };
  }
  return { ok: true, result: parsed.data };
}

/** A demote attempt: the page and its fresh clock, or why nothing moved. */
export type DemoteOutcome =
  | { ok: true; result: DemoteResult }
  | { ok: false; error: PublishError };

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
  let response: Response;
  try {
    response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/demote`, {
      method: "POST",
      signal,
    });
  } catch {
    return { ok: false, error: unreachable("demoted") };
  }

  if (response.status !== 200) {
    return { ok: false, error: await readError(response, "demote the page") };
  }

  const parsed = demoteResultSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        error: "internal_error",
        message:
          "kept answered with something this page could not read. Reload to see whether the page is still kept.",
      },
    };
  }
  return { ok: true, result: parsed.data };
}

/** A swap attempt: both halves of the transaction, or the reason there were none. */
export type SwapOutcome =
  | { ok: true; result: SwapResult }
  | { ok: false; error: PublishError };

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
  let response: Response;
  try {
    response = await fetch("/api/sites/swap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    return { ok: false, error: unreachable("swapped") };
  }

  if (response.status !== 200) {
    return { ok: false, error: await readError(response, "swap the pages") };
  }

  const parsed = swapResultSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        error: "internal_error",
        message:
          "kept answered with something this page could not read. Reload to see which pages are kept.",
      },
    };
  }
  return { ok: true, result: parsed.data };
}

/** A replace attempt: the page with its new version, or why it did not land. */
export type ReplaceOutcome =
  | { ok: true; page: ReplaceResult }
  | { ok: false; error: PublishError };

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
 * delayed second purge ends, and `STALE_EDGE_MINUTES` is its bound. In practice
 * it is seconds — do not "tighten" this to an instant swap.
 */
export function replaceNotice(page: ReplaceResult): string {
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
  let response: Response;
  try {
    response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/replace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    return { ok: false, error: unreachable("replaced") };
  }

  if (response.status !== 200) {
    return { ok: false, error: await readError(response, "replace the file") };
  }

  const parsed = replaceResultSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        error: "internal_error",
        message:
          "kept answered with something this page could not read. Reload to see which file is live.",
      },
    };
  }
  return { ok: true, page: parsed.data };
}

/** A delete attempt: the archived page and the freed slot, or the failure. */
export type DeleteOutcome =
  | { ok: true; result: DeleteResult }
  | { ok: false; error: PublishError };

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
  let response: Response;
  try {
    response = await fetch(`/api/sites/${encodeURIComponent(siteId)}`, {
      method: "DELETE",
      signal,
    });
  } catch {
    return { ok: false, error: unreachable("deleted") };
  }

  if (response.status !== 200) {
    return { ok: false, error: await readError(response, "delete the page") };
  }

  const parsed = deleteResultSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        error: "internal_error",
        message:
          "kept answered with something this page could not read. Reload to see whether the page was deleted.",
      },
    };
  }
  return { ok: true, result: parsed.data };
}

/**
 * An account teardown: what was destroyed, or why nothing was.
 *
 * `signedOut` is its own branch rather than a message, because the only useful
 * response to it is a navigation to sign-in — printing "Sign in to manage this
 * page" inside a dialog on a screen that already rendered a session would read
 * as a bug.
 */
export type AccountDeletionOutcome =
  | { ok: true; result: AccountDeletionResult }
  | { ok: false; signedOut: true }
  | { ok: false; signedOut?: false; error: PublishError };

/**
 * `DELETE /api/account` — a signed-in user destroys their own account
 * (E06 task 011's route, epic decision **D3**).
 *
 * ⚠️ THE PHRASE IS THE REQUEST, NOT MERELY THE UI'S GATE. `confirm` is checked
 * server-side against `accountDeletionRequestSchema`, so a stray
 * `fetch("/api/account", { method: "DELETE" })` from this app's own origin
 * cannot destroy an account by arriving. That is also why this function takes
 * the phrase rather than hardcoding it: the caller passes what the user actually
 * typed, and a mismatch is refused by the server rather than smoothed over here.
 *
 * ⚠️ NO PATH SEGMENT NAMING A VICTIM, EVER. The route resolves the profile from
 * the session; there is nothing for this function to send that says whose
 * account to delete, and adding one would turn "delete my account" into a
 * deletion endpoint that takes an argument.
 *
 * The four refusals the route can produce all arrive as `{ error, message }`
 * with the server's own sentence, and the caller shows it verbatim:
 *   · 400 — the phrase did not match exactly
 *   · 401 — the session is gone (its own branch above)
 *   · 403 — the request did not come from the app's configured origin
 *   · 503 — a page could not be taken off the edge, so **nothing** was deleted
 *
 * Never throws, including on abort.
 */
export async function deleteAccount(
  confirm: string,
  signal?: AbortSignal,
): Promise<AccountDeletionOutcome> {
  let response: Response;
  try {
    response = await fetch("/api/account", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm }),
      signal,
    });
  } catch {
    return { ok: false, error: unreachable("deleted") };
  }

  if (response.status === 401) return { ok: false, signedOut: true };

  if (response.status !== 200) {
    return { ok: false, error: await readError(response, "delete your account") };
  }

  const parsed = accountDeletionResultSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        error: "internal_error",
        message:
          "kept answered with something this page could not read. Sign out and sign in again to see whether your account is still there.",
      },
    };
  }
  return { ok: true, result: parsed.data };
}
