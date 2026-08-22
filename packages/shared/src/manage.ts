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
