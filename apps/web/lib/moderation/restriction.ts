/**
 * A restricted page as its owner sees it (E07 §6.9, §6.10, §9, D13) — the one
 * view model behind `components/kept/restricted-banner.tsx`, which the studio
 * `/site/[id]` and `/p/[anonToken]` both render.
 *
 * It never carries a rule name, a score or a probability: only the Appendix A
 * sentence for the reason, and a note a PERSON wrote (the statement of reasons
 * shows only those, `lib/email/moderation.ts`).
 *
 * `withholdsBytes` is D13's byte rule: a page restricted for child sexual abuse
 * material serves its bytes to nobody — no preview, no download, no export.
 */
import {
  APPEALS_PER_SITE_WINDOW,
  MODERATION_REASON_SENTENCES,
  type ModerationReason,
  type SiteStatus,
} from "@kept/shared";

import { readRestrictionRecord, type RestrictionRecord } from "../db/queries/restriction";
import { MS_PER_DAY } from "../sites/display";

/** Whether nothing may serve this page's bytes to anyone (D13). */
export function withholdsBytes(site: { moderationReason: ModerationReason | null }): boolean {
  return site.moderationReason === "child_sexual_abuse";
}

/** Where the owner stands on asking for a review. */
export type AppealStanding =
  | { state: "open" }
  | { state: "available"; rejectedNote: string | null }
  | { state: "limited"; rejectedNote: string | null; retryAt: Date };

export interface RestrictionView {
  status: Extract<SiteStatus, "under_review" | "quarantined" | "removed">;
  /** Appendix A's sentence; `null` when no reason was recorded. */
  reason: string | null;
  /** The reviewer's note — a person's only, never the scanner's. */
  note: string | null;
  /** A removed page: when the purge deletes it for good. */
  deletesOn: Date | null;
  /** A removed page its owner may still download (never for `withholdsBytes`). */
  downloadable: boolean;
  appeal: AppealStanding;
}

export interface RestrictedSite {
  id: string;
  status: RestrictionView["status"];
  moderationReason: ModerationReason | null;
  purgeAfter: Date | null;
}

/** The statuses the banner is for — `isManagementRestricted`'s, narrowed. */
export function isRestrictedSite<T extends { status: SiteStatus }>(
  site: T,
): site is T & { status: RestrictionView["status"] } {
  return site.status === "under_review" || site.status === "quarantined" || site.status === "removed";
}

const WINDOW_MS = APPEALS_PER_SITE_WINDOW.days * MS_PER_DAY;

/** The view, from the rows. Pure. */
export function restrictionView(site: RestrictedSite, record: RestrictionRecord): RestrictionView {
  const removed = site.status === "removed";
  const rejectedNote = record.latestAppeal?.status === "rejected" ? record.latestAppeal.decisionNote : null;
  const { count, oldest } = record.window;

  let appeal: AppealStanding;
  if (record.latestAppeal?.status === "open") appeal = { state: "open" };
  else if (count >= APPEALS_PER_SITE_WINDOW.limit && oldest) {
    appeal = { state: "limited", rejectedNote, retryAt: new Date(oldest.getTime() + WINDOW_MS) };
  } else appeal = { state: "available", rejectedNote };

  return {
    status: site.status,
    reason: site.moderationReason ? MODERATION_REASON_SENTENCES[site.moderationReason].sentence : null,
    note: record.latestAction?.actor === "admin" ? record.latestAction.note : null,
    deletesOn: removed ? site.purgeAfter : null,
    downloadable: removed && !withholdsBytes(site),
    appeal,
  };
}

/** Read and build the banner's view for one page the caller has already scoped. */
export async function readRestriction(site: RestrictedSite, now = new Date()): Promise<RestrictionView> {
  return restrictionView(site, await readRestrictionRecord(site.id, new Date(now.getTime() - WINDOW_MS)));
}
