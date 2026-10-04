/**
 * The HTTP shape of the owner-scoped (studio) endpoints — E05 task 010,
 * extended by E06.
 *
 * `POST /api/sites` · `POST /api/sites/:id/keep` · `POST /api/sites/:id/demote`
 * `POST /api/sites/swap` · `PATCH /api/sites/:id/name` · `GET /api/names/check`
 * `POST /api/sites/:id/replace` · `DELETE /api/sites/:id` · `DELETE /api/account`
 *
 * ── WHAT THIS MODULE IS FOR ────────────────────────────────────────────────
 * Validation and result→response mapping, and nothing else. Every database
 * decision — the cap, the row locks, the clocks — lives in `./keep.ts` and is
 * called, never re-implemented. The `route.ts` files above this are the
 * session boundary: they resolve who is signed in, then hand a profile id here.
 * Splitting it that way is what makes these paths testable against the real dev
 * database without a Next request scope (`next/headers` throws outside one).
 *
 * ── THE ERROR ENVELOPE (E06 task 005) ──────────────────────────────────────
 * Every studio failure answers `{ error: { code, message } }`, `code ∈
 * STUDIO_ERROR_CODES`, parsed through `studioErrorSchema` before it leaves.
 * Three doors lead into it, and only three:
 *
 *   1. A lib module THROWS a `StudioRefusal` (`./studio-refusal.ts`) —
 *      `SiteNotFoundError`, `SiteNotReplaceableError`, the store errors, and
 *      every refusal later tasks add. `studioFailure` maps it through ONE table,
 *      `STUDIO_ERROR_STATUS`, so a new refusal is a `throw` in its lib module and
 *      never a new branch in the functions below.
 *   2. The shared publish pipeline REFUSED (`requestError`, `contentRejected`,
 *      `slugUnavailable` — flat `PublishError`s, because `/api/publish` and
 *      `/api/anon/*` answer agents and their bodies are frozen).
 *      `fromPublishFailure` translates them here, at the boundary, and never by
 *      changing what the pipeline emits.
 *   3. `refuse(code, message)` for the few refusals this module decides itself.
 *
 * Two bodies stay outside it ON PURPOSE: E05a's origin 403
 * (`refuseUntrustedOrigin`, which runs before anything here) and the 401 below,
 * whose STATUS is the whole message.
 *
 * ⚠️ NO STORE CALLS HERE ON THE KEEP / DEMOTE / SWAP PATHS. Keeping a `live`
 * page and demoting are Postgres writes, not publishes: the manifest the Worker
 * reads carries `ownerId`, nothing in `apps/edge` reads it, and `status` stays
 * `live` throughout, so there is nothing for the edge to learn — see the header
 * of `./keep.ts` for why writing the manifest "for consistency" is a real
 * regression. The one exception, the LATE KEEP of an `expired` page in its grace
 * window, writes its manifest inside `./keep.ts` after the commit; this module
 * only maps its refusals.
 *
 * ⚠️ PUBLISH, RENAME, REPLACE AND DELETE ARE THE EXCEPTIONS, AND THEY ARE ON
 * PURPOSE. Storing a page's first bytes, moving a slug, storing new bytes and
 * taking a page off the internet are all unavoidably edge operations — but each
 * ordering lives in exactly one place, `./publish.ts`, `../names/rename.ts` and
 * `./manage.ts`, and this module only maps their refusals. Nothing here calls
 * `writeManifest`/`removeManifest`/`r2Store` directly, and nothing new may.
 *
 * ⚠️ "YOU DON'T OWN THIS" IS AN EXISTENCE ORACLE. A site that does not exist, a
 * site owned by somebody else and an id that is not even a uuid all produce the
 * byte-identical `404 not_found` below (D17: never 403). `SiteNotFoundError`
 * carries one constant sentence; this module must not un-collapse them.
 *
 * ⚠️ THE CAP IS A BRANCH, NOT AN ERROR — on publish. Publishing at the plan's
 * kept limit lands an owned draft (201), never a 4xx.
 */
import {
  ACCOUNT_DELETION_CONFIRMATION,
  accountDeletionRequestSchema,
  accountDeletionResultSchema,
  deleteResultSchema,
  demoteResultSchema,
  keepResultSchema,
  nameChangeRequestSchema,
  nameChangeResultSchema,
  nameCheckResultSchema,
  ownedPublishResultSchema,
  replaceResultSchema,
  studioErrorSchema,
  swapResultSchema,
  type AccountDeletionResult,
  type DeleteResult,
  type DemoteResult,
  type KeepResult,
  type NameChangeResult,
  type NameCheckResult,
  type OwnedPublishResult,
  type PublishErrorCode,
  type ReplaceResult,
  type StudioErrorCode,
  type SwapResult,
} from "@kept/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { SlugUnavailableError } from "../db/queries/publish";
import { allowNameCheck, checkName } from "../names/check";
import { renameSite } from "../names/rename";
import { checkHeuristics } from "../publish/hooks";
import {
  contentRejected,
  requestError,
  slugUnavailable,
  type PublishFailure,
  type PublisherContext,
} from "../publish/pipeline";
import { deleteAccount } from "./account-deletion";
import { demoteSite, keepSite, SITE_NOT_FOUND_MESSAGE, swapKept } from "./keep";
import { deleteSite, ownerPageBodySchema, replaceSite } from "./manage";
import { publishOwnedPage } from "./publish";
import { StudioRefusal } from "./studio-refusal";

/** A studio refusal, ready to answer: the status and the validated envelope. */
export type StudioFailure = {
  ok: false;
  status: number;
  body: z.infer<typeof studioErrorSchema>;
};

/** Success bodies differ per operation; the failure shape never does. */
export type OwnerOutcome<T> = { ok: true; status: 200 | 201; body: T } | StudioFailure;

/**
 * THE ONE TABLE: the HTTP status every studio code answers with. A `Record`
 * over the closed enum, so a code added to `STUDIO_ERROR_CODES` does not
 * compile until it has a status here. The client branches on `code`; the status
 * is for HTTP tooling, retries and logs.
 *
 * `internal_error` is 503 because a TYPED one is a known, transient store
 * failure where nothing changed and a retry is the answer. An UNTYPED throw is
 * not in this table — `studioFailure` answers it 500 itself.
 */
const STUDIO_ERROR_STATUS = {
  not_found: 404,
  version_not_found: 404,
  invalid_request: 400,
  invalid_file: 400,
  name_invalid: 400,
  name_too_short: 400,
  name_pro_length: 400,
  name_reserved: 400,
  name_inappropriate: 400,
  file_too_large: 413,
  content_rejected: 422,
  name_taken: 409,
  name_quota: 409,
  not_allowed_in_status: 409,
  at_kept_limit: 409,
  unchanged: 409,
  last_sign_in_method: 409,
  rename_rate_limited: 429,
  rate_limited: 429,
  slug_unavailable: 503,
  internal_error: 503,
} as const satisfies Record<StudioErrorCode, number>;

/**
 * The flat pipeline codes, in studio vocabulary. Only the body's SHAPE is
 * translated here; what `/api/publish` emits is untouched. `turnstile_failed`
 * cannot reach a studio route (none runs Turnstile) and lands on the generic
 * request refusal if it ever did.
 */
const STUDIO_CODE_FOR: Record<PublishErrorCode, StudioErrorCode> = {
  invalid_request: "invalid_request",
  empty_page: "invalid_file",
  page_too_large: "file_too_large",
  turnstile_failed: "invalid_request",
  rate_limited: "rate_limited",
  content_rejected: "content_rejected",
  slug_unavailable: "slug_unavailable",
  internal_error: "internal_error",
};

/** The envelope, built and validated in one place. */
function failure(status: number, code: StudioErrorCode, message: string): StudioFailure {
  return { ok: false, status, body: studioErrorSchema.parse({ error: { code, message } }) };
}

/** A refusal this module decides itself, at its code's status. */
export function refuse(code: StudioErrorCode, message: string): StudioFailure {
  return failure(STUDIO_ERROR_STATUS[code], code, message);
}

/** A shared-pipeline refusal (flat `PublishError`), translated into the envelope. */
export function fromPublishFailure(refusal: PublishFailure): StudioFailure {
  return refuse(STUDIO_CODE_FOR[refusal.body.error], refusal.body.message);
}

/**
 * THE typed-failure mapping. A `StudioRefusal` answers with its own code and
 * sentence at the table's status, its `detail` logged and never sent. Anything
 * else is a bug: logged with the operation, answered 500 with `unexpected` —
 * by default the promise that nothing was left half-written, which every page
 * verb can make because its stores unwind before it throws.
 */
export function studioFailure(
  err: unknown,
  operation: string,
  unexpected = `kept could not ${operation} this page. Nothing was left half-written — retry the request.`,
): StudioFailure {
  if (err instanceof StudioRefusal) {
    if (err.detail) console.error(`[owner-routes] ${operation} refused — ${err.detail}`);
    return refuse(err.code, err.message);
  }
  console.error(
    `[owner-routes] ${operation} failed unexpectedly — ${err instanceof Error ? err.message : String(err)}`,
  );
  return failure(500, "internal_error", unexpected);
}

/**
 * The `[id]` path segment. A value that is not a uuid cannot name a site, so it
 * gets the same 404 as a real id belonging to somebody else — a 400 here would
 * be a free "that id is at least well-formed" oracle.
 */
export const siteIdSchema = z.string().uuid();

/**
 * `POST /api/sites/swap`. Both ids are required and must differ: swapping a
 * page with itself would demote the very page it then keeps, which is a caller
 * bug rather than a cap branch, so it is a 400.
 */
export const swapRequestSchema = z
  .object({
    demote: z.string().uuid(),
    keep: z.string().uuid(),
  })
  .refine((body) => body.demote !== body.keep, {
    message:
      "`demote` and `keep` must name different pages — swapping a page with itself would demote the page it is meant to keep.",
    path: ["keep"],
  });

export type SwapRequest = z.infer<typeof swapRequestSchema>;

/**
 * The ONE response for "no such page" and "not your page" — the same sentence
 * `SiteNotFoundError` carries, so a 404 reached by a malformed id here and one
 * thrown from a query can never drift into distinguishable bodies.
 */
export function ownerNotFound(): StudioFailure {
  return refuse("not_found", SITE_NOT_FOUND_MESSAGE);
}

/**
 * Nobody is signed in. Exported for the route handlers, which own the session
 * lookup: `getSession()` reads `next/headers` and cannot be called from here.
 *
 * The one failure whose STATUS is the message: 401 means "sign in again", and
 * no studio code exists for it because the client navigates rather than
 * printing anything. The body is still the envelope.
 */
export function signedOut(): StudioFailure {
  return failure(401, "invalid_request", "Sign in to manage this page.");
}

/**
 * The one outcome→response mapping, so the `route.ts` files cannot drift on
 * status, headers or error shape. Never cacheable: every one of them mutates.
 */
export function ownerResponse<T>(outcome: OwnerOutcome<T>): NextResponse {
  return NextResponse.json(outcome.body, {
    status: outcome.status,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * `POST /api/sites` — publish a page that belongs to this account from its first
 * byte. Decision **D9**.
 *
 * ⚠️ THIS IS NOT `POST /api/publish` WITH A SESSION. That endpoint is the
 * KEYLESS one: it mints an `anon_token_hash`, leaves `owner_id` null and starts
 * a clock, and composing it with a keep would be two non-atomic requests with an
 * orphan window between them — plus a bearer token handed to a browser for a
 * page the account already owns. `./publish.ts` owns the transaction and the
 * store ordering, and mints no token at all.
 *
 * **201 `{ site }`** for a new page — kept under the plan's limit, an owned
 * draft at it (the cap DEGRADES; there is no 4xx for being full).
 * **200 `{ site, duplicate: true }`** when this account already has these exact
 * bytes live (PRD §5.1, AC8): nothing new is written.
 *
 * TURNSTILE AND `checkRateLimit` ARE NOT RUN and must not be added "for
 * symmetry": the caller is authenticated by a `__Host-` session cookie and an
 * origin check (see `./publish.ts`). The heuristic content check DOES run, in
 * the same position as every other path that stores bytes — being signed in is
 * not a content policy.
 */
export async function publishOwnedSite(
  raw: unknown,
  profileId: string,
  publisher: PublisherContext,
): Promise<OwnerOutcome<OwnedPublishResult>> {
  const parsed = ownerPageBodySchema.safeParse(raw);
  if (!parsed.success) return fromPublishFailure(requestError(parsed.error));

  const heuristics = await checkHeuristics(parsed.data.html);
  if (!heuristics.allowed) return fromPublishFailure(contentRejected(heuristics.reason));

  try {
    const result = await publishOwnedPage({ profileId, html: parsed.data.html, publisher });
    // Parse our own output: the studio repaints its card from this body without
    // a second request, so a silent shape change here is a broken screen rather
    // than a failed test.
    return {
      ok: true,
      status: result.duplicate ? 200 : 201,
      body: ownedPublishResultSchema.parse(result),
    };
  } catch (err) {
    if (err instanceof SlugUnavailableError) {
      // The same 503 and the same sentence the anonymous pipeline gives for the
      // same exhausted mint — translated, not re-spelled.
      console.error(`[kept] ${err.message}`);
      return fromPublishFailure(slugUnavailable());
    }
    return studioFailure(err, "publish");
  }
}

/**
 * Keep an owned page forever — or, for an `expired` page inside its grace
 * window, bring it back online and keep it (the late keep).
 *
 * `expectAnonymous` is left at its default `false`, which is the whole
 * difference between this route and the anonymous keep: the row must ALREADY
 * belong to this profile, and at the plan's kept limit the answer is
 * `409 at_kept_limit` rather than an `owned_draft` (E06 task 004, PRD §10.2). A
 * signed-in user pointing this endpoint at somebody's unclaimed draft must not
 * walk through the anonymous→owned door, which is bearer-token authority and
 * lives behind `/api/anon/`.
 *
 * Keeping an already-kept page is a no-op success, and demote → immediate keep
 * is allowed with no cooldown; both fall out of `keepSite`, as do its refusals
 * (`not_found`, `not_allowed_in_status`, `at_kept_limit`), and none needs a
 * branch here.
 */
export async function keepOwnedSite(
  rawSiteId: string,
  profileId: string,
): Promise<OwnerOutcome<KeepResult>> {
  const parsed = siteIdSchema.safeParse(rawSiteId);
  if (!parsed.success) return ownerNotFound();

  try {
    const result = await keepSite(parsed.data, profileId);
    // Parse our own output: E06's dashboard branches on `outcome` and reads
    // `quota` without a second request, so a silent shape change here is a
    // broken dashboard rather than a failed test.
    return { ok: true, status: 200, body: keepResultSchema.parse(result) };
  } catch (err) {
    return studioFailure(err, "keep");
  }
}

/**
 * Put a kept page back on a fresh draft clock, freeing a slot.
 *
 * ⚠️ DESTRUCTIVE-ISH: the page keeps serving at the same URL and nothing is
 * removed, but it acquires a deadline and will expire unless it is kept again.
 * The confirmation ("this page becomes a draft and expires in DRAFT_TTL_DAYS
 * days") is the CALLER's — E06 renders it. This endpoint does not confirm, and
 * must not be called without one.
 *
 * Only a kept `live` page can be demoted; a draft or a flagged page is
 * `409 not_allowed_in_status`, thrown by `demoteSite`.
 */
export async function demoteOwnedSite(
  rawSiteId: string,
  profileId: string,
): Promise<OwnerOutcome<DemoteResult>> {
  const parsed = siteIdSchema.safeParse(rawSiteId);
  if (!parsed.success) return ownerNotFound();

  try {
    const result = await demoteSite(parsed.data, profileId);
    return { ok: true, status: 200, body: demoteResultSchema.parse(result) };
  } catch (err) {
    return studioFailure(err, "demote");
  }
}

/**
 * Demote one page and keep another in a single transaction, so the account can
 * never be observed a slot short or a page over the cap. Both ids must be owned
 * by the caller; either failing is the same 404. `demote` must be kept `live`
 * and `keep` a draft (`live`, or `expired` in grace), else
 * `409 not_allowed_in_status`.
 */
export async function swapOwnedSites(
  raw: unknown,
  profileId: string,
): Promise<OwnerOutcome<SwapResult>> {
  const parsed = swapRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return refuse(
      "invalid_request",
      parsed.error.issues[0]?.message ??
        "Send `{ demote, keep }`, both site ids belonging to this account.",
    );
  }

  try {
    const result = await swapKept(parsed.data.demote, parsed.data.keep, profileId);
    return { ok: true, status: 200, body: swapResultSchema.parse(result) };
  } catch (err) {
    return studioFailure(err, "swap");
  }
}

/**
 * `PATCH /api/sites/:id/name` — move an owned kept page to a name its owner
 * chose (PRD §5.4).
 *
 * Every rule lives in `../names/rename.ts`, inside one transaction: the name
 * rule, kept-and-`live` only (a draft is `409 not_allowed_in_status`, AC17), the
 * namespace under a per-name lock, the quota and the 24 h limit — each refusal a
 * `StudioRefusal` carrying the field's own sentence. A name taken between the
 * field's check and this save is `409 name_taken`, never a 500 (edge case 3).
 *
 * Success is the page as it now is: the new `slug` and `liveUrl`, `nameKind:
 * "chosen"`, and a moved `updatedAt`.
 */
export async function changeOwnedSiteName(
  rawSiteId: string,
  raw: unknown,
  profileId: string,
): Promise<OwnerOutcome<NameChangeResult>> {
  const parsedId = siteIdSchema.safeParse(rawSiteId);
  if (!parsedId.success) return ownerNotFound();

  const parsed = nameChangeRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return refuse("invalid_request", "Send `{ name }` — the new name for this page.");
  }

  try {
    const site = await renameSite(parsedId.data, profileId, parsed.data.name);
    return { ok: true, status: 200, body: nameChangeResultSchema.parse({ site }) };
  } catch (err) {
    return studioFailure(err, "rename");
  }
}

/**
 * `GET /api/names/check?name=&siteId=` — what the name field shows as you type.
 *
 * A READ: one status and the numbers its sentence needs, no copy (the words
 * are `apps/web`'s, `lib/names/messages.ts`). `siteId` must be the caller's
 * page — anything else is the same 404 as a page that does not exist. The
 * answer is advisory: the rename re-asks under its locks.
 *
 * A per-minute budget per account, in process (`allowNameCheck`); over it
 * is `429 rate_limited`. The durable rename limit is a check STATUS, not this.
 */
export async function checkOwnedName(
  rawSiteId: string | null,
  rawName: string | null,
  profileId: string,
): Promise<OwnerOutcome<NameCheckResult>> {
  if (!allowNameCheck(profileId)) {
    return refuse("rate_limited", "That's a lot of names in a minute. Wait a moment, then try again.");
  }

  const parsedId = siteIdSchema.safeParse(rawSiteId);
  if (!parsedId.success) return ownerNotFound();

  try {
    const result = await checkName(rawName ?? "", profileId, parsedId.data);
    return { ok: true, status: 200, body: nameCheckResultSchema.parse(result) };
  } catch (err) {
    return studioFailure(err, "check a name for", "kept could not check that name just now. Try again.");
  }
}

/**
 * `POST /api/sites/:id/replace` — new bytes, same URL.
 *
 * VALIDATION AND CONTENT POLICY HAPPEN HERE, ORDERING HAPPENS IN `./manage.ts`,
 * the same split rename uses. `ownerPageBodySchema` is the publish schema's `html`
 * field, so `MAX_PAGE_BYTES`, the empty-page rule and every error CODE are
 * identical to the path that first stored the page — `requestError` is the
 * shared mapper, because "the body was 6 MB" and "the body had no `html` field"
 * arriving as one code is an infinite retry loop for an agent.
 *
 * ⚠️ THE CLOCK IS NOT TOUCHED, AND THE RESPONSE SAYS SO by echoing the deadline
 * it found. A replace that extended the draft window would let a weekly upload
 * hold a page forever for free.
 *
 * ⚠️ A FLAGGED PAGE IS REFUSED WITH AN EXPLANATION, NOT HIDDEN — 409 and the
 * sentence `./display.ts` gives the card, so the screen and the error body agree.
 */
export async function replaceOwnedSite(
  rawSiteId: string,
  raw: unknown,
  profileId: string,
): Promise<OwnerOutcome<ReplaceResult>> {
  const parsedId = siteIdSchema.safeParse(rawSiteId);
  if (!parsedId.success) return ownerNotFound();

  const parsed = ownerPageBodySchema.safeParse(raw);
  if (!parsed.success) return fromPublishFailure(requestError(parsed.error));

  // The same E07 seam the anonymous replace runs, in the same position: before
  // anything is stored. A replace is a re-publish, and a path that stores new
  // bytes without the content check is a hole big enough to publish anything
  // through — publish clean, then replace with the payload.
  const heuristics = await checkHeuristics(parsed.data.html);
  if (!heuristics.allowed) return fromPublishFailure(contentRejected(heuristics.reason));

  try {
    const result = await replaceSite(parsedId.data, profileId, parsed.data.html);
    return { ok: true, status: 200, body: replaceResultSchema.parse(result) };
  } catch (err) {
    // A page that is not `live` is `409 not_allowed_in_status`, with the
    // sentence `./display.ts` gives the card — thrown by `./manage.ts`.
    return studioFailure(err, "replace");
  }
}

/**
 * `DELETE /api/sites/:id` — stop serving one page.
 *
 * ⚠️ ARCHIVE, NOT DESTROY, AND NOT THE ACCOUNT-DELETION VERB. This lands
 * `status = 'archived'` with the row, the versions and the R2 object all
 * retained; deleting an *account* is the path that lands `removed` with a
 * `purge_after` (task 011). Two verbs, two terminal states, both deliberate.
 *
 * The freed slot rides back on the response so the dashboard can repaint its
 * quota without a second request, and a `quarantined` page is deletable on
 * purpose — delete is one of the two affordances a flagged page keeps.
 */
export async function deleteOwnedSite(
  rawSiteId: string,
  profileId: string,
): Promise<OwnerOutcome<DeleteResult>> {
  const parsed = siteIdSchema.safeParse(rawSiteId);
  if (!parsed.success) return ownerNotFound();

  try {
    const result = await deleteSite(parsed.data, profileId);
    return { ok: true, status: 200, body: deleteResultSchema.parse(result) };
  } catch (err) {
    return studioFailure(err, "delete");
  }
}

/**
 * `DELETE /api/account` — the only irreversible action in the product.
 * E06 task 011, epic decision **D3**.
 *
 * ⚠️ THERE IS NO ID PARAMETER, AND THERE MUST NEVER BE ONE. The profile id comes
 * from the session the route handler resolved, so the endpoint cannot be pointed
 * at another account by any request a caller can construct. An `id` here — even
 * one that was checked — would be a deletion verb that *takes a victim's name*,
 * one forgotten early return away from working.
 *
 * ⚠️ THE BODY IS THE SECOND HALF OF D3'S DOUBLE GATE. `accountDeletionRequestSchema`
 * requires the literal `ACCOUNT_DELETION_CONFIRMATION`, so the request itself
 * carries the intent and the gate is real even for a caller that never rendered a
 * dialog. The first half — a dialog stating the account's REAL kept/draft counts
 * from `getAccountDeletionSummary`, with the button disabled until the phrase
 * matches — is task 012's, and this refusal is what makes it more than decoration.
 * A bare "are you sure?" is not acceptable for an act that kills permanent links
 * other people may be pointing at.
 *
 * 400, not 422: a body without the phrase is a caller that did not ask for this,
 * and the message names the phrase because a developer wiring the dialog is the
 * only person who will ever read it.
 *
 * ⚠️ ARCHIVE IS THE OTHER VERB. This one ends every page in `removed` with a
 * `purge_after` — see `./account-deletion.ts` for why the two terminal states
 * differ on purpose, and why the R2 objects deliberately survive this call.
 */
export async function deleteOwnAccount(
  raw: unknown,
  profileId: string,
): Promise<OwnerOutcome<AccountDeletionResult>> {
  const parsed = accountDeletionRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return refuse(
      "invalid_request",
      `Send \`{ confirm: "${ACCOUNT_DELETION_CONFIRMATION}" }\` — deleting an account is permanent and has to be typed out.`,
    );
  }

  try {
    const result = await deleteAccount(profileId);
    return { ok: true, status: 200, body: accountDeletionResultSchema.parse(result) };
  } catch (err) {
    // `AccountDeletionStoreError` is thrown before the transaction opens, so its
    // "nothing was deleted" is literally true. An UNEXPECTED throw gets its own
    // sentence, not the page verbs' "nothing was left half-written": the unwind
    // may have taken pages off the edge before it, so this says what a retry
    // actually does.
    return studioFailure(
      err,
      "account deletion",
      "kept could not finish deleting your account. Some of your pages may already have stopped being served; retrying the deletion is safe and will finish the job.",
    );
  }
}
