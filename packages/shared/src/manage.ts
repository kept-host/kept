// @kept/shared — the owner management contract (E06).
//
// Rename (task 005), replace and delete (task 006), and the owned publish
// (task 004) — four verbs, one file rather than four, for the reason ./keep
// gives: one closed set with two consumers — the route handlers in apps/web and
// the browser client that parses their responses (`lib/sites/owner-client.ts`) —
// so the wire shape can never drift between them.
//
// ⚠️ CONTROL PLANE ONLY. `apps/edge` must never import this. A rename is a KV
// pointer change the Worker learns about by reading KV, exactly as it learns
// about a publish; it has no notion of the operation that caused it.

import { z } from "zod";

import { keepResultBranches, keptQuotaSchema, type KeepResult, type KeptQuota } from "./keep";

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

/**
 * What a signed-in publish returns — `POST /api/sites` (task 004, epic D1).
 *
 * ⚠️ THE OUTCOME VOCABULARY IS `KeepResult`'s, NOT A NEW ONE. A signed-in
 * publish resolves the same two ways a keep does — under the cap the page is
 * `kept` and has no clock; at the cap it lands as an `owned_draft` with its
 * countdown intact and a swap prompt — so it reuses those branches verbatim
 * rather than inventing a third word for the same two states. **The cap is a
 * branch, not an error: both outcomes are HTTP 200 and there is no 4xx for
 * being full.**
 *
 * Two fields are added, and both exist because this response is what the
 * drop-zone repaints from without a second request:
 *
 *   · `liveUrl` — the page's public address, built server-side from
 *     `KEPT_BASE_DOMAIN`. A client that concatenated `slug` with a domain of its
 *     own would be wrong on dev the first time it ran.
 *   · `title` — the `<title>` extracted from the bytes just published, `null`
 *     when there is none. The card renders `title ?? slug`, so it needs the
 *     value the row was actually given, not a guess.
 *
 * There is deliberately no `anonToken` and no `claim_url`: an owned page has one
 * authority, the account. `PublishResponse` (the keyless contract in ./publish)
 * carries both and is a different shape for a different caller — that split is
 * the whole of D1.
 */
export type OwnedPublishResult = KeepResult & {
  /** `https://{slug}.{base}` — built by the control plane, never by the client. */
  liveUrl: string;
  /** Extracted from the published bytes; `null` when they carry no `<title>`. */
  title: string | null;
};

/** The two fields the publish branches add to `keepResultBranches`. */
const ownedPublishExtras = {
  liveUrl: z.string().url(),
  title: z.string().nullable(),
} as const;

export const ownedPublishResultSchema = z.discriminatedUnion("outcome", [
  keepResultBranches.kept.extend(ownedPublishExtras),
  keepResultBranches.ownedDraft.extend(ownedPublishExtras),
]);

/**
 * `PATCH /api/sites/:id/slug`.
 *
 * The slug is typed only as a string HERE, deliberately, and NOT as
 * `slugSchema`. The shape rule, the reserved-label rule and the profanity rule
 * are applied together by `checkChosenSlug` in
 * `apps/web/lib/publish/slug.ts`, which owns the wording of all three refusals
 * so a human editing their own URL gets one voice instead of a zod string. If
 * this schema enforced the shape as well, the route would answer with zod's
 * message before that function was ever reached.
 */
export const renameRequestSchema = z.object({
  slug: z.string(),
});

export type RenameRequest = z.infer<typeof renameRequestSchema>;

/**
 * What a rename returns.
 *
 * `slug` IS THE FIELD THAT MATTERS. `/site/[slug]` is keyed by slug, so the
 * client must `router.replace` onto this value the moment the response lands —
 * otherwise the user's next navigation 404s on their own page.
 *
 * `previousSlug` is carried so the success copy can name the old URL it is
 * telling the truth about (it keeps serving briefly — see `renameNotice` in
 * `apps/web/lib/sites/owner-client.ts`). It equals `slug` on the one no-op
 * case: renaming a page to the name it already has, which writes nothing.
 */
export interface RenameResult {
  siteId: string;
  slug: string;
  previousSlug: string;
  /** `https://{slug}.{base}` — built by the control plane, never by the client. */
  liveUrl: string;
}

export const renameResultSchema = z.object({
  siteId: z.string(),
  slug: z.string(),
  previousSlug: z.string(),
  liveUrl: z.string().url(),
});

/**
 * What a replace returns — `POST /api/sites/:id/replace`.
 *
 * ⚠️ `expiresAt` IS ECHOED BECAUSE IT DID NOT MOVE. A replace swaps the bytes
 * and touches neither clock: if re-dropping a file restarted the
 * `DRAFT_TTL_DAYS` window, a weekly upload would hold a page forever for free
 * and "keep it" would stop meaning anything. The field is here so a card can
 * repaint its countdown from the response and visibly show the *same* deadline,
 * rather than the client assuming a value the server never confirmed. `null`
 * means the page is kept and has no clock at all.
 *
 * `versionId` is the NEW `site_versions` row. Version history is retained —
 * the previous version is never deleted — and the rollback UI that consumes it
 * is E11's, not this epic's.
 *
 * `title` is RE-EXTRACTED from the new bytes and may legitimately be `null`
 * when the replacement carries no readable `<title>`. Carrying the old one
 * forward would make the dashboard confidently display the previous page's
 * name, which is worse than displaying the slug.
 *
 * There is no `slug` change and no `previousSlug`: a replace keeps the URL. That
 * is the whole point of it, and it is why the manifest is rewritten for the same
 * key instead of moved.
 */
export interface ReplaceResult {
  siteId: string;
  slug: string;
  /** `https://{slug}.{base}` — unchanged by the replace, built server-side. */
  liveUrl: string;
  /** The new version. The previous one is retained, never deleted. */
  versionId: string;
  /** Re-extracted from the new bytes; `null` when they carry no `<title>`. */
  title: string | null;
  /** The UNTOUCHED draft clock. `null` ⇒ kept. */
  expiresAt: string | null;
}

export const replaceResultSchema = z.object({
  siteId: z.string(),
  slug: z.string(),
  liveUrl: z.string().url(),
  versionId: z.string(),
  title: z.string().nullable(),
  expiresAt: z.string().datetime().nullable(),
});

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
