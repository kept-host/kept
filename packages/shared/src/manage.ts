// @kept/shared — the owner management contract (E06).
//
// Rename today; task 006's replace and delete extend this file rather than
// minting a second one. It sits beside ./keep for the same reason that file
// gives: one closed set with two consumers — the route handlers in apps/web and
// the browser client that parses their responses (`lib/sites/owner-client.ts`) —
// so the wire shape can never drift between them.
//
// ⚠️ CONTROL PLANE ONLY. `apps/edge` must never import this. A rename is a KV
// pointer change the Worker learns about by reading KV, exactly as it learns
// about a publish; it has no notion of the operation that caused it.

import { z } from "zod";

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
