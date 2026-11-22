/**
 * `PATCH /api/profile` (E10 D12, PRD §4.6, AC19) — display name, bio, socials
 * and badge style.
 *
 * The shape is `profileUpdateRequestSchema`'s (bio ≤ 160, socials `https://`
 * on their network's hosts). Whether `minimal` is allowed is a plan question,
 * `mayUseMinimalBadge` (Q19). A badge-style CHANGE re-syncs every kept page
 * through the `repurge` job (`resyncOwnerPages`, Q4) — after the commit, so a
 * replay cannot write the old style. Name, bio and socials write no KV: nothing
 * at the edge shows them until E12's wall.
 */
import { profileUpdateRequestSchema, type Plan, type ProfileResult } from "@kept/shared";

import { resyncOwnerPages } from "../badge/fan-out";
import { updateProfileFields } from "../db/queries/profile";
import { mayUseMinimalBadge } from "../plans/badge";
import { StudioRefusal } from "../sites/studio-refusal";

export const MINIMAL_BADGE_PRO_MESSAGE = "The minimal badge is a Pro feature.";

/**
 * Validate `raw` and write it for `owner`.
 *
 * @throws {StudioRefusal} `invalid_request` — a field the schema refuses (its
 *   own sentence), or `minimal` on a plan that may not wear it
 */
export async function updateProfile(owner: { id: string; plan: Plan }, raw: unknown): Promise<ProfileResult> {
  const parsed = profileUpdateRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StudioRefusal("invalid_request", parsed.error.issues[0]?.message ?? "Check your profile and try again.");
  }
  const fields = parsed.data;
  if (fields.badgeStyle === "minimal" && !mayUseMinimalBadge(owner.plan)) {
    throw new StudioRefusal("invalid_request", MINIMAL_BADGE_PRO_MESSAGE);
  }

  const { profile, previousBadgeStyle } = await updateProfileFields(owner.id, fields);

  if (profile.badgeStyle !== previousBadgeStyle) {
    // COMMITTED. A failure to queue is logged: the style is saved, and the
    // pages show it from their next sync.
    try {
      await resyncOwnerPages(owner.id);
    } catch (err) {
      console.error(
        `[kept] badge style: re-sync not queued for profile ${owner.id} — ${err instanceof Error ? err.message : String(err)}. Kept pages show the old style until their next sync.`,
      );
    }
  }
  return profile;
}
