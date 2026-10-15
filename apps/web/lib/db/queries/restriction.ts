/**
 * What the restricted banner reads about one page (E07 §6.10, §9) — the studio
 * `/site/[id]` and `/p/[anonToken]` both render it. Reads only; every write is
 * `lib/moderation`'s, through `./moderation.ts`.
 *
 * The caller has already scoped the page to its owner or its token: these
 * statements take a site id and nothing else.
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "../index";
import { appeals, moderationActions } from "../schema";
import { appealsSince } from "./moderation";

/** The steps that restrict a page; the latest one carries the reviewer's note. */
const RESTRICTING_ACTIONS = ["flag", "hide", "remove"] as const;

export interface RestrictionRecord {
  /** The page's most recent appeal, whatever its outcome. */
  latestAppeal: { status: "open" | "granted" | "rejected"; decisionNote: string | null } | null;
  /** Appeals since the window's start — the limit `submitAppeal` enforces. */
  window: { count: number; oldest: Date | null };
  /** Who made the latest restricting step, and their note. */
  latestAction: { actor: "scanner" | "report" | "admin"; note: string | null } | null;
}

/** One snapshot of the three reads, so the banner never mixes two moments. */
export function readRestrictionRecord(siteId: string, windowStart: Date): Promise<RestrictionRecord> {
  return db.transaction(async (tx) => {
    const [latestAppeal] = await tx
      .select({ status: appeals.status, decisionNote: appeals.decisionNote })
      .from(appeals)
      .where(eq(appeals.siteId, siteId))
      .orderBy(desc(appeals.createdAt))
      .limit(1);
    const window = await appealsSince(tx, siteId, windowStart);
    const [latestAction] = await tx
      .select({ actor: moderationActions.actor, note: moderationActions.note })
      .from(moderationActions)
      .where(and(eq(moderationActions.siteId, siteId), inArray(moderationActions.action, [...RESTRICTING_ACTIONS])))
      .orderBy(desc(moderationActions.createdAt))
      .limit(1);
    return { latestAppeal: latestAppeal ?? null, window, latestAction: latestAction ?? null };
  });
}
