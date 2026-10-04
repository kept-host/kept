// @kept/shared — the owner management contract (E06).
//
// Rename (task 005), replace and delete (task 006), restore (task 007), and the
// owned publish (task 004) — one file rather than one per verb, for the reason
// ./keep gives: one closed set with two consumers — the route handlers in apps/web and
// the browser client that parses their responses (`lib/sites/owner-client.ts`) —
// so the wire shape can never drift between them.
//
// ⚠️ CONTROL PLANE ONLY. `apps/edge` must never import this. A rename is a KV
// pointer change the Worker learns about by reading KV, exactly as it learns
// about a publish; it has no notion of the operation that caused it.

import { z } from "zod";

import { nameKindEnum, siteStatusEnum } from "./enums";
import { keptQuotaSchema, type KeptQuota } from "./keep";

/**
 * Every code a studio (cookie-authenticated) route may answer with — the error
 * half of the result schemas below, the way `PUBLISH_ERROR_CODES` is the error
 * half of `./publish`. A closed enum: the studio client switches on it, so a
 * free-form code is a branch nobody wrote.
 *
 * ⚠️ TWO ERROR SHAPES, ON PURPOSE. Studio routes answer `studioErrorSchema`'s
 * envelope; the keyless agent routes (`POST /api/publish`, `/api/anon/*`) keep
 * their frozen flat `PublishError`, because agents parse it. E05a's origin 403
 * keeps its own body too — it runs before any route code.
 */
export const STUDIO_ERROR_CODES = [
  // PRD §7's closed list.
  "not_found",
  "invalid_file",
  "file_too_large",
  "name_invalid",
  "name_too_short",
  "name_pro_length",
  "name_reserved",
  "name_taken",
  "name_quota",
  "rename_rate_limited",
  "not_allowed_in_status",
  "at_kept_limit",
  "version_not_found",
  "unchanged",
  "last_sign_in_method",
  // The epic's five (Risk 2): the studio routes run the shared publish
  // pipeline and the names-check limiter, which already fail these ways, and
  // the PRD's list would leave them unrepresentable.
  "invalid_request",
  "content_rejected",
  "slug_unavailable",
  "rate_limited",
  "internal_error",
  // Arun's decision 5: the word filter pulled forward from E07 refuses with its
  // own code, mirroring `validateName`'s `inappropriate`.
  "name_inappropriate",
] as const;

export const studioErrorCodeEnum = z.enum(STUDIO_ERROR_CODES);
export type StudioErrorCode = (typeof STUDIO_ERROR_CODES)[number];

/** The body every non-2xx studio response carries: `{ error: { code, message } }`. */
export const studioErrorSchema = z.object({
  error: z.object({
    code: studioErrorCodeEnum,
    /** Written for the person reading the field or toast, not for a log. */
    message: z.string(),
  }),
});

/** The inside of the envelope — what the studio client hands its callers. */
export type StudioError = z.infer<typeof studioErrorSchema>["error"];

/**
 * A page as the studio sees it — the `site` every studio response that changes
 * a page carries (`POST /api/sites` first; D9).
 *
 * Wire-shaped: timestamps are ISO 8601 strings, and `liveUrl` is built by the
 * control plane from `KEPT_BASE_DOMAIN` — a client that concatenated `slug` with
 * a domain of its own would be wrong on dev the first time it ran.
 *
 * `isDraft = expiresAt != null`, exactly as on the row: a publish past the plan's
 * kept limit comes back with its clock set, and that is the ONLY way the caller
 * learns it landed as a draft. There is no `outcome` field to disagree with it.
 *
 * `title` is `null` when the page has no usable `<title>`; render `title ?? slug`.
 */
export const studioSiteSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  /** `https://{slug}.{base}` — built by the control plane, never by the client. */
  liveUrl: z.string().url(),
  title: z.string().nullable(),
  status: siteStatusEnum,
  /** `generated` (minted) or `chosen` (renamed by the owner, counted against the name quota — D3). */
  nameKind: nameKindEnum,
  /** The draft clock. Set ⇒ draft; `null` ⇒ kept. */
  expiresAt: z.string().datetime().nullable(),
  /** End of the post-expiry grace window; `null` on a kept page. */
  purgeAfter: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});

export type StudioSite = z.infer<typeof studioSiteSchema>;

/**
 * What `POST /api/sites` returns (D9, PRD §7).
 *
 * - **201 `{ site }`** — a new page. Kept while the account is under its plan's
 *   kept limit, otherwise an OWNED DRAFT (`site.expiresAt` set). **The cap is a
 *   branch, not an error**: there is no 4xx for being full.
 * - **200 `{ site, duplicate: true }`** — this account already has an active
 *   page with these exact bytes (PRD §5.1, AC8). No new page is made; `site` is
 *   the existing one, so the studio can point at it.
 *
 * There is deliberately no `anonToken` and no `claim_url`: an owned page has one
 * authority, the account. `PublishResponse` (the keyless contract in ./publish)
 * is a different shape for a different caller.
 */
export const ownedPublishResultSchema = z.object({
  site: studioSiteSchema,
  duplicate: z.literal(true).optional(),
});

export type OwnedPublishResult = z.infer<typeof ownedPublishResultSchema>;

/**
 * `PATCH /api/sites/:id/name` — the name the owner chose (PRD §5.4).
 *
 * Typed only as a string HERE, deliberately, and NOT as `slugSchema`: every
 * refusal and its wording belong to `validateName` (`@kept/shared/names`) and
 * the names module in `apps/web`, so a person editing their own URL reads the
 * field's sentence rather than zod's.
 */
export const nameChangeRequestSchema = z.object({
  name: z.string(),
});

export type NameChangeRequest = z.infer<typeof nameChangeRequestSchema>;

/**
 * What a rename returns: the page as it now is — the new `slug` and `liveUrl`,
 * `nameKind: "chosen"`, and an `updatedAt` that moved (the OG card's cache key).
 */
export const nameChangeResultSchema = z.object({
  site: studioSiteSchema,
});

export type NameChangeResult = z.infer<typeof nameChangeResultSchema>;

/**
 * What `GET /api/names/check?name=&siteId=` returns: ONE status in PRD §5.4's
 * precedence (`NAME_CHECK_STATUSES`), plus the numbers its sentence needs.
 *
 * ⚠️ NO COPY ON THE WIRE. The words live in `apps/web` and interpolate these
 * numbers, which come from `limitsFor(plan)` and the database (PRD §11: no
 * numbers in strings). `too_short` carries the plan's minimum; `quota` the
 * chosen names in use and the plan's quota; `rate_limited` the renames made in
 * the last 24 hours. `held_for_you` reads as available — and `taken` covers a
 * name held for somebody else, so the hold is never revealed.
 */
export const nameCheckResultSchema = z.union([
  z.object({ status: z.literal("too_short"), min: z.number().int().positive() }),
  z.object({
    status: z.literal("quota"),
    count: z.number().int().nonnegative(),
    quota: z.number().int().positive(),
  }),
  z.object({ status: z.literal("rate_limited"), count: z.number().int().nonnegative() }),
  z.object({
    status: z.enum([
      "invalid",
      "pro_length",
      "reserved",
      "inappropriate",
      "held_for_you",
      "taken",
      "available",
    ]),
  }),
]);

export type NameCheckResult = z.infer<typeof nameCheckResultSchema>;

/**
 * A replace or restore that changed nothing (D7): the bytes were identical to
 * the current version's, or the version asked for is already current. Nothing
 * was written — no version row, no R2 object, no manifest.
 */
const versionUnchangedSchema = z.object({ unchanged: z.literal(true) });

/**
 * A replace or restore that moved the page to a different version (D7).
 *
 * ⚠️ `expiresAt` IS ECHOED BECAUSE IT DID NOT MOVE. Neither verb touches either
 * clock: if re-dropping a file restarted the `DRAFT_TTL_DAYS` window, a weekly
 * upload would hold a page forever for free and "keep it" would stop meaning
 * anything. The field is here so a card can repaint its countdown from the
 * response and visibly show the *same* deadline. `null` ⇒ kept.
 *
 * `versionId` is the version now served; `previousVersionId` the one that was
 * current a moment ago — what the Undo toast restores (AC25), and what "back"
 * restores after a restore.
 *
 * `title` is the title the row holds AFTER the change: the served bytes'
 * `<title>` — legitimately `null` when they carry none — unless the owner named
 * the page (`title_source = 'owner'`, D11), which neither verb overwrites.
 *
 * There is no `slug` change: both verbs keep the URL, which is why the manifest
 * is rewritten for the same key instead of moved.
 */
const versionChangedSchema = z.object({
  unchanged: z.literal(false),
  siteId: z.string(),
  slug: z.string(),
  /** `https://{slug}.{base}` — unchanged, built server-side. */
  liveUrl: z.string().url(),
  /** The version now served. */
  versionId: z.string(),
  /** The version that was current before; `null` only for a row that had none. */
  previousVersionId: z.string().nullable(),
  /** The stored title: the served bytes' `<title>` (or `null`), or the owner's. */
  title: z.string().nullable(),
  /** The UNTOUCHED draft clock. `null` ⇒ kept. */
  expiresAt: z.string().datetime().nullable(),
});

/**
 * What a replace returns — `POST /api/sites/:id/replace` (PRD §5.5).
 *
 * `{ unchanged: true }` for bytes identical to the current version (AC27).
 * Otherwise a new version, and `pruned` says whether keeping the plan's
 * `previousVersions` dropped the oldest one — the studio's cue for "Free
 * accounts keep one previous version." (task 012).
 */
export const replaceResultSchema = z.discriminatedUnion("unchanged", [
  versionUnchangedSchema,
  versionChangedSchema.extend({ pruned: z.boolean() }),
]);

export type ReplaceResult = z.infer<typeof replaceResultSchema>;

/**
 * What a restore returns — `POST /api/sites/:id/versions/:versionId/restore`.
 *
 * `{ unchanged: true }` when that version is already current. A restore moves
 * the pointer and writes no bytes, so it never prunes: the count is unchanged.
 */
export const restoreResultSchema = z.discriminatedUnion("unchanged", [
  versionUnchangedSchema,
  versionChangedSchema,
]);

export type RestoreResult = z.infer<typeof restoreResultSchema>;

/**
 * What deleting ONE page returns — `DELETE /api/sites/:id`.
 *
 * ⚠️ `status` IS PINNED TO `archived`, AND THAT IS THE DECISION, NOT A DEFAULT.
 * An owner deleting a single page **archives** it: the row is retained, the R2
 * object is retained, and E07's grace window is what eventually collects it. An
 * owner deleting their whole **account** is the one path that ends in `removed`
 * with a `purge_after` set, because there is no owner left to offer a download
 * to. Two delete verbs, two terminal states, both deliberate — see the epic's
 * locked decisions before "harmonising" them.
 *
 * `quota` rides along because the slot frees the moment the status moves
 * (`countKept` requires `status = 'live'`), and the dashboard must be able to
 * repaint "Kept · N of 3" from this response without a second round trip.
 */
export interface DeleteResult {
  siteId: string;
  slug: string;
  /** Always `archived` — never `removed`, which belongs to account deletion. */
  status: "archived";
  /** The account's allowance after the delete. The freed slot, visible. */
  quota: KeptQuota;
}

export const deleteResultSchema = z.object({
  siteId: z.string(),
  slug: z.string(),
  status: z.literal("archived"),
  quota: keptQuotaSchema,
});

/**
 * The literal a user types to arm account deletion — `DELETE /api/account`
 * (E06 task 011, epic decision **D3**).
 *
 * ⚠️ IT LIVES HERE BECAUSE BOTH HALVES OF THE GATE READ IT. The settings dialog
 * (task 012) renders it and compares what was typed so the destructive button
 * can enable; the route below parses the request body against it so the gate is
 * real even for a caller that never rendered a dialog. One value, so the button
 * can never enable on a string the server would refuse — and so a stray
 * `fetch("/api/account", { method: "DELETE" })` from the app's own origin cannot
 * destroy an account by arriving.
 *
 * ⚠️ EXACT MATCH, DELIBERATELY. No trim, no case-folding, no "close enough".
 * This is the only irreversible action in the product and it kills permanent
 * links other people may be pointing at; the typing IS the deliberation. Task
 * 012 owns the surrounding copy and may change these words — change them HERE
 * and both halves follow — but it must stay a literal phrase compared exactly,
 * and the input must be rendered with autocapitalisation off so a phone does not
 * fight the user.
 *
 * NOT the account's email address: this string ends up in a request body, and
 * an address there is one log line away from being somewhere it should not be.
 */
export const ACCOUNT_DELETION_CONFIRMATION = "delete my account" as const;

/**
 * The body of `DELETE /api/account`. One field, and it must be the phrase.
 *
 * A delete that carried no body would be a delete that any misrouted request
 * could perform; requiring the phrase makes the request itself carry the
 * intent, which is the same reason the dialog requires typing it.
 */
export const accountDeletionRequestSchema = z.object({
  confirm: z.literal(ACCOUNT_DELETION_CONFIRMATION),
});

export type AccountDeletionRequest = z.infer<typeof accountDeletionRequestSchema>;

/**
 * What deleting a whole ACCOUNT returns — `DELETE /api/account`.
 *
 * ⚠️ `status` IS PINNED TO `removed`, AND IT IS NOT `DeleteResult`'s `archived`.
 * The two delete verbs end in deliberately different terminal states (D3):
 *
 *   · one page   → `archived` — the row and the R2 object are retained so the
 *                  OWNER can still download them during E07's window.
 *   · one account → `removed` + `purge_after` — because the owner is precisely
 *                  who no longer exists. There is nobody to offer a download to,
 *                  and `status IN (expired, removed) AND purge_after < now()` is
 *                  exactly what E07's daily purge job selects on, so the bytes
 *                  are collected by machinery that is already designed.
 *
 * **That is not drift and must not be harmonised.** See the epic's locked
 * decisions before touching either literal.
 *
 * There is no `quota`: the account it would describe is gone. There is no
 * `siteId`/`slug` either — the affected pages are every page the account had,
 * and enumerating them into a response body nobody is left to read would only
 * be a list of names for whoever holds the session next.
 *
 * ⚠️ `purgeAfter` IS A HANDOFF, NOT A PROMISE THAT THE BYTES ARE GONE. E07's
 * purge job does not exist yet, so R2 objects legitimately persist after this
 * returns. Deletion copy may say "your pages stop being served immediately; the
 * files are erased shortly after"; it may **not** say "erased immediately".
 */
export interface AccountDeletionResult {
  /** How many rows were flipped to `removed` — every page the account had. */
  pagesRemoved: number;
  /** Always `removed` — never `archived`, which belongs to the single-page delete. */
  status: "removed";
  /** The deadline E07's purge orders on. Already in the past when this returns. */
  purgeAfter: string;
}

export const accountDeletionResultSchema = z.object({
  pagesRemoved: z.number().int().nonnegative(),
  status: z.literal("removed"),
  purgeAfter: z.string().datetime(),
});
