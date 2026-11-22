/**
 * What a page's badge shows, from Postgres (E10 D3) — the one builder of the
 * manifest's `badge`. `syncManifest` and `storeNewPage` call it with the row
 * `lib/db/queries/manifest-sync.ts` reads; nothing else decides a badge field.
 *
 * Pure: the row in, `BadgeData` out. The Worker renders it (`renderBadge`) and
 * escapes every value there; this only decides which fields exist.
 *
 *   draft (expires_at set)  → `{ variant: 'draft', style: 'standard' }` and
 *                              nothing else: no owner, no ref, no model (D4).
 *   kept                    → the owner's credit: `refCode` (current handle,
 *                              else the permanent code — Q3), `handle`, `model`
 *                              when "Made with" is on, `readme` when the page
 *                              has one (Q6), `remix` per `remixAllowed` (Q12),
 *                              `minimal` only for a Pro profile that chose it.
 *
 * A kept page always has an owner; one without (an anomaly) still gets a kept
 * badge, just without the owner's fields.
 */
import { remixAllowed, type BadgeData, type BadgeStyle, type Plan } from "@kept/shared";

import { mayUseMinimalBadge } from "../plans/badge";

/** The columns a badge is built from: the site row, and its owner's profile (null fields when anonymous). */
export interface BadgeRow {
  expiresAt: Date | null;
  model: string | null;
  showMadeWith: boolean;
  readme: string | null;
  allowRemix: boolean | null;
  handle: string | null;
  referralCode: string | null;
  badgeStyle: BadgeStyle | null;
  plan: Plan | null;
}

export function badgeDataFor(row: BadgeRow): BadgeData {
  if (row.expiresAt !== null) return { variant: "draft", style: "standard" };

  const model = row.model?.trim() || null;
  const minimal = row.badgeStyle === "minimal" && row.plan !== null && mayUseMinimalBadge(row.plan);
  const refCode = row.handle ?? row.referralCode;
  return {
    variant: "kept",
    style: minimal ? "minimal" : "standard",
    ...(model !== null && row.showMadeWith && { model }),
    ...(Boolean(row.readme?.trim()) && { readme: true as const }),
    ...(remixAllowed({ allowRemix: row.allowRemix, kept: true, model }) && { remix: true as const }),
    ...(refCode !== null && { refCode }),
    ...(row.handle !== null && { handle: row.handle }),
  };
}
