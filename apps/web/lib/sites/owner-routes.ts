/**
 * The HTTP shape of the owner-scoped endpoints — E05 task 010, extended by E06.
 *
 * `POST /api/sites/:id/keep` · `POST /api/sites/:id/demote` · `POST /api/sites/swap`
 * `PATCH /api/sites/:id/slug` (E06 task 005)
 *
 * ── WHAT THIS MODULE IS FOR ────────────────────────────────────────────────
 * Validation and result→response mapping, and nothing else. Every database
 * decision — the cap, the row locks, the clocks — lives in `./keep.ts` and is
 * called, never re-implemented. The three `route.ts` files above this are the
 * session boundary: they resolve who is signed in, then hand a profile id here.
 * Splitting it that way is what makes these paths testable against the real dev
 * database without a Next request scope (`next/headers` throws outside one).
 *
 * ⚠️ NO STORE CALLS ON THE KEEP / DEMOTE / SWAP PATHS. Keeping and demoting are
 * Postgres writes, not publishes: the manifest the Worker reads carries
 * `ownerId`, nothing in `apps/edge` reads it, and `status` stays `live`
 * throughout, so there is nothing for the edge to learn. No `writeManifest`, no
 * `removeManifest`, no R2, no purge — see the header of `./keep.ts` for why
 * writing the manifest "for consistency" is a real regression rather than a
 * harmless extra. The one manifest-touching branch in E05 is the late keep of an
 * `expired` row, and it belongs to the anonymous keep route, not to these.
 *
 * ⚠️ RENAME IS THE EXCEPTION, AND IT IS ONE ON PURPOSE. The slug is the KV key,
 * so moving it is unavoidably an edge operation — but the ordering still lives
 * in exactly one place, `./rename.ts`, and this module only maps its errors onto
 * statuses. Nothing here calls `writeManifest`/`removeManifest` directly, and
 * nothing new may.
 *
 * ⚠️ "YOU DON'T OWN THIS" IS AN EXISTENCE ORACLE. A site that does not exist, a
 * site owned by somebody else and an id that is not even a uuid all produce the
 * byte-identical 404 below. `keepSite`/`demoteSite`/`swapKept` already collapse
 * the first two into one `SiteNotFoundError` with one message; this module must
 * not un-collapse them.
 *
 * ⚠️ THE CAP IS A BRANCH, NOT AN ERROR. Keeping at `KEPT_PAGE_LIMIT` returns
 * HTTP 200 with `outcome: "owned_draft"` — the page is owned, its countdown is
 * intact, and the caller renders a swap prompt. There is no 4xx for being at
 * the cap and there must never be one.
 *
 * The error body is the publish family's closed `PublishError` shape, reused
 * rather than re-invented so the control plane fails exactly one way. The
 * *status* carries the distinction a caller acts on (401 sign in again, 404
 * gone-or-not-yours, 400 caller bug); the code stays `invalid_request` because
 * the enum is closed and shared with `apps/edge`'s consumers.
 */
import {
  demoteResultSchema,
  keepResultSchema,
  renameRequestSchema,
  renameResultSchema,
  swapResultSchema,
  type DemoteResult,
  type KeepResult,
  type RenameResult,
  type SwapResult,
} from "@kept/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse } from "../publish/http";
import { fail, type PublishFailure } from "../publish/pipeline";
import { checkChosenSlug } from "../publish/slug";
import { demoteSite, keepSite, SiteNotFoundError, swapKept } from "./keep";
import {
  renameSite,
  RenameStoreError,
  SiteNotRenamableError,
  SlugTakenError,
} from "./rename";

/** Success bodies differ per operation; the failure shape never does. */
export type OwnerOutcome<T> = { ok: true; status: 200; body: T } | PublishFailure;

/**
 * The `[id]` path segment. A value that is not a uuid cannot name a site, so it
 * gets the same 404 as a real id belonging to somebody else — a 400 here would
 * be a free "that id is at least well-formed" oracle.
 */
export const siteIdSchema = z.string().uuid();

/**
 * `POST /api/sites/swap`. Both ids are required and must differ: swapping a
 * page with itself would demote the very page it then keeps, which is a caller
 * bug rather than a cap branch, so it is the one 400 these routes emit.
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
 * The ONE response for "no such page" and "not your page". One function, so the
 * two can never drift into distinguishable bodies.
 */
export function ownerNotFound(): PublishFailure {
  return fail(404, {
    error: "invalid_request",
    message:
      "No page with that id is available on this account. It may have been deleted, or the id may be wrong.",
  });
}

/**
 * Nobody is signed in. Exported for the route handlers, which own the session
 * lookup: `getSession()` reads `next/headers` and cannot be called from here.
 */
export function signedOut(): PublishFailure {
  return fail(401, {
    error: "invalid_request",
    message: "Sign in to manage this page.",
  });
}

/**
 * The one outcome→response mapping, so the three `route.ts` files above cannot
 * drift on status, headers or error shape. Never cacheable: all three mutate.
 */
export function ownerResponse<T>(outcome: OwnerOutcome<T>): NextResponse {
  if (!outcome.ok) return errorResponse(outcome.status, outcome.body);
  return NextResponse.json(outcome.body, {
    status: outcome.status,
    headers: { "cache-control": "no-store" },
  });
}

/** An unexpected throw. Logged with the operation, answered without detail. */
function unexpected(operation: string, err: unknown): PublishFailure {
  console.error(
    `[owner-routes] ${operation} failed unexpectedly — ${err instanceof Error ? err.message : String(err)}`,
  );
  return fail(500, {
    error: "internal_error",
    message: `kept could not ${operation} this page. Nothing was left half-written — retry the request.`,
  });
}

/**
 * Keep an owned page forever, or — at the cap — own it and leave the clock on.
 *
 * `expectAnonymous` is left at its default `false`, which is the whole
 * difference between this route and the anonymous keep: the row must ALREADY
 * belong to this profile. A signed-in user pointing this endpoint at somebody's
 * unclaimed draft must not walk through the anonymous→owned door, which is
 * bearer-token authority and lives behind `/api/anon/`.
 *
 * Keeping an already-kept page is a no-op success, and demote → immediate keep
 * is allowed with no cooldown; both fall out of `keepSite` and neither needs a
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
    if (err instanceof SiteNotFoundError) return ownerNotFound();
    return unexpected("keep", err);
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
 * Demoting a page that is already a draft is a no-op success with a fresh
 * clock, not an error.
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
    if (err instanceof SiteNotFoundError) return ownerNotFound();
    return unexpected("demote", err);
  }
}

/**
 * Demote one page and keep another in a single transaction, so the account can
 * never be observed a slot short or a page over the cap. Both ids must be owned
 * by the caller; either failing is the same 404.
 */
export async function swapOwnedSites(
  raw: unknown,
  profileId: string,
): Promise<OwnerOutcome<SwapResult>> {
  const parsed = swapRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(400, {
      error: "invalid_request",
      message:
        parsed.error.issues[0]?.message ??
        "Send `{ demote, keep }`, both site ids belonging to this account.",
    });
  }

  try {
    const result = await swapKept(parsed.data.demote, parsed.data.keep, profileId);
    return { ok: true, status: 200, body: swapResultSchema.parse(result) };
  } catch (err) {
    if (err instanceof SiteNotFoundError) return ownerNotFound();
    return unexpected("swap", err);
  }
}

/**
 * `PATCH /api/sites/:id/slug` — move an owned page to a name its owner chose.
 *
 * THREE REFUSALS BEFORE ANY WRITE, and each one applies nothing: a malformed
 * body, a slug that fails `checkChosenSlug` (shape, reserved label, profanity),
 * and — inside `renameSite`, where the unique index answers it — a slug that is
 * taken. The first two never open a transaction at all.
 *
 * ⚠️ THERE IS NO PRE-FLIGHT AVAILABILITY QUERY, AND ADDING ONE WOULD BE A BUG.
 * `slug.ts` states the rule: "a pre-flight 'is this slug free?' query is a race,
 * and `sites_slug_key` is the only authority." The availability signal a rename
 * field shows while you type is therefore ADVISORY and comes from this endpoint's
 * own error path — a `409` whose message says the name is taken — not from a
 * separate GET that the write then trusts. A check that gates the write is a
 * TOCTOU bug with a nice spinner: two people can pass it in the same second and
 * only one of them can have the name. The shape/reserved/profanity half of the
 * live indicator needs no server at all, because `checkChosenSlug` is pure and
 * the browser runs the same function (see `./owner-client.ts`).
 *
 * A collision that appears BETWEEN whatever the field last showed and this call
 * therefore arrives as "taken", never as a 500.
 */
export async function renameOwnedSite(
  rawSiteId: string,
  raw: unknown,
  profileId: string,
): Promise<OwnerOutcome<RenameResult>> {
  const parsedId = siteIdSchema.safeParse(rawSiteId);
  if (!parsedId.success) return ownerNotFound();

  const parsed = renameRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(400, {
      error: "invalid_request",
      message: "Send `{ slug }` — the new name for this page.",
    });
  }

  // Shape, reserved labels and profanity, in the one function the browser also
  // calls. `null` means the string is acceptable; whether it is AVAILABLE is a
  // different question and only the index below can answer it.
  const refusal = checkChosenSlug(parsed.data.slug);
  if (refusal) {
    return fail(400, { error: "invalid_request", message: refusal.message });
  }

  try {
    const result = await renameSite(parsedId.data, profileId, parsed.data.slug);
    return { ok: true, status: 200, body: renameResultSchema.parse(result) };
  } catch (err) {
    if (err instanceof SiteNotFoundError) return ownerNotFound();
    // 409, not 400: the request was well-formed and the answer is about the
    // world's state, not the caller's syntax. The code stays `invalid_request`
    // because the error enum is closed and shared with `apps/edge`'s consumers.
    if (err instanceof SlugTakenError) {
      return fail(409, {
        error: "invalid_request",
        message: `"${err.slug}" is already taken. Try another name.`,
      });
    }
    if (err instanceof SiteNotRenamableError) {
      return fail(409, { error: "invalid_request", message: err.message });
    }
    if (err instanceof RenameStoreError) {
      // Nothing was applied — the transaction rolled back — so the honest
      // answer is "retry", not "we half-moved your page". Logged with the step
      // that failed, which is the only place that detail exists.
      console.error(`[owner-routes] rename refused — ${err.message}`);
      return fail(503, {
        error: "internal_error",
        message:
          "kept could not move this page to the new address just now. Nothing changed — the page is still live at its current one. Try again in a moment.",
      });
    }
    return unexpected("rename", err);
  }
}
