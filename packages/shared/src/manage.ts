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

import { PAGE_TITLE_MAX_LENGTH } from "./constants";
import { nameKindEnum, siteStatusEnum, titleSourceEnum } from "./enums";
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
  /** Who wrote `title`: the page's own `<title>`, or its owner (D11). */
  titleSource: titleSourceEnum,
  status: siteStatusEnum,
  /** `generated` (minted) or `chosen` (renamed by the owner, counted against the name quota — D3). */
  nameKind: nameKindEnum,
  /** "List on Explore when it opens" (D12) — stored now, used by E15. */
  listedPublic: z.boolean(),
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
 * `PATCH /api/sites/:id` — the page's Details (PRD §5.2): its title and its
 * Explore flag. Either or both; an empty body is a caller bug.
 *
 * `title` is whitespace-collapsed and trimmed, then held to
 * `PAGE_TITLE_MAX_LENGTH` — the cap the extracted title has (D11). `""` (after
 * trimming) is not an empty title: it hands the title back to the page's own
 * `<title>` (`title_source = 'html'`). Any other value is the owner's
 * (`title_source = 'owner'`), and no replace overwrites it.
 *
 * `listedPublic` is a kept `live` page's choice only (D12); the route refuses it
 * on any other page with `not_allowed_in_status`.
 */
export const siteUpdateRequestSchema = z
  .object({
    title: z
      .string()
      .transform((title) => title.replace(/\s+/g, " ").trim())
      .pipe(
        z
          .string()
          .max(PAGE_TITLE_MAX_LENGTH, `Titles can be up to ${PAGE_TITLE_MAX_LENGTH} characters.`),
      )
      .optional(),
    listedPublic: z.boolean().optional(),
  })
  .refine((body) => body.title !== undefined || body.listedPublic !== undefined, {
    message: "Send `{ title }`, `{ listedPublic }`, or both.",
  });

export type SiteUpdateRequest = z.input<typeof siteUpdateRequestSchema>;

/** What a Details save returns: the page as it now is, `updatedAt` moved. */
export const siteUpdateResultSchema = z.object({
  site: studioSiteSchema,
});

export type SiteUpdateResult = z.infer<typeof siteUpdateResultSchema>;

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
 * What deleting ONE page returns — `DELETE /api/sites/:id` (D14).
 *
 * `status` is always `archived`: owners reach `archived`; `removed` is E07's.
 *
 * `quota` rides along because the slot frees the moment the status moves
 * (`isKeptCondition` excludes `archived`), and the studio must be able to
 * repaint its kept counter from this response without a second round trip.
 */
export interface DeleteResult {
  siteId: string;
  slug: string;
  /** Always `archived`. */
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
 * The verbs `POST /api/sites/bulk` runs over many pages at once — the drafts
 * tab's multi-select. Each is the single-page verb, applied per page: `keep` is
 * `POST /api/sites/:id/keep`'s, `delete` is `DELETE /api/sites/:id`'s (D14:
 * archive, never destroy). There is no bulk swap: Swap… stays a one-page flow.
 */
export const BULK_ACTIONS = ["keep", "delete"] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

/**
 * The most pages one bulk request may name. A cap on the REQUEST, not a plan
 * limit: a bulk keep is held to the owner's free kept slots long before this,
 * and a bulk delete takes each page off the edge (Cloudflare calls per page), so
 * an unbounded list is an unbounded burst at the purge API.
 */
export const BULK_MAX_PAGES = 200;

/**
 * The body of `POST /api/sites/bulk`. `ids` are plain strings, not uuids: an id
 * that is not a uuid is reported as that page's `not_found`, exactly like one
 * that belongs to somebody else — a 400 for a malformed id would be a free
 * "this one is at least well-formed" oracle (`siteIdSchema`'s rule).
 */
export const bulkRequestSchema = z.object({
  action: z.enum(BULK_ACTIONS),
  ids: z
    .array(z.string())
    .min(1, "Name at least one page.")
    .max(BULK_MAX_PAGES, `Name at most ${BULK_MAX_PAGES} pages at a time.`),
});

export type BulkRequest = z.infer<typeof bulkRequestSchema>;

/**
 * One page's outcome: done, or the studio code and sentence that refused it —
 * the same pair the single-page route would have answered with. A page another
 * account owns is `not_found`, never a 403 (D17).
 */
export const bulkItemResultSchema = z.discriminatedUnion("ok", [
  z.object({ id: z.string(), ok: z.literal(true) }),
  z.object({ id: z.string(), ok: z.literal(false), code: studioErrorCodeEnum, message: z.string() }),
]);

export type BulkItemResult = z.infer<typeof bulkItemResultSchema>;

/**
 * What a bulk request returns (200): one result per distinct id, in the order
 * they were sent. A refusal of the WHOLE request — a keep that would overrun
 * the owner's free kept slots (`409 at_kept_limit`, all or nothing) — is the
 * studio envelope instead, and nothing was written.
 */
export const bulkResultSchema = z.object({
  results: z.array(bulkItemResultSchema),
});

export type BulkResult = z.infer<typeof bulkResultSchema>;

/**
 * The body of `DELETE /api/account` (D16): the account's email, typed by the
 * person deleting it. The request itself carries the intent, so a stray
 * `fetch("/api/account", { method: "DELETE" })` cannot delete an account.
 *
 * THE RULE, ONE PLACE, BOTH HALVES: `confirmsAccountEmail` — trimmed, and
 * case-insensitive (an address's case carries no meaning to the person typing
 * it). The settings dialog arms its button with it; the route refuses with it.
 */
export const accountDeletionRequestSchema = z.object({
  email: z.string(),
});

export type AccountDeletionRequest = z.infer<typeof accountDeletionRequestSchema>;

/** Whether `typed` confirms deleting the account whose email is `accountEmail`. */
export function confirmsAccountEmail(typed: string, accountEmail: string): boolean {
  return typed.trim().toLowerCase() === accountEmail.trim().toLowerCase();
}

/**
 * What deleting a whole ACCOUNT returns — `DELETE /api/account` (D16).
 *
 * Every page the account had is `archived` with no owner and offline, its
 * chosen names held with no owner. `pagesArchived` counts the pages this call
 * took offline; pages already archived keep their own deadline.
 *
 * There is no `quota`, `siteId` or `slug`: the account they would describe is
 * gone, and a list of its names in a body nobody is left to read would only be
 * a list for whoever holds the session next.
 */
export const accountDeletionResultSchema = z.object({
  pagesArchived: z.number().int().nonnegative(),
});

export type AccountDeletionResult = z.infer<typeof accountDeletionResultSchema>;
