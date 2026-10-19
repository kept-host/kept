/**
 * Every SQL statement `lib/moderation` runs (E07 §6.7, §6.10). The module is
 * the only writer of moderation status edges and of `sites.moderation_reason`;
 * these are its statements, kept here so no SQL lives in the decision code.
 *
 * Locks are the caller's to order: `lockOwner` (owned pages) → the site row
 * (`lockSiteForModeration`) → names (`holdName` / `dropRemovedHold`).
 */
import type { ModerationAction, ModerationActor, ModerationReason, SiteStatus } from "@kept/shared";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";

import { claimsItsName } from "../../names/availability";
import { db, type Tx } from "../index";
import { appeals, moderationActions, scans, sites, user } from "../schema";

/** The columns a moderation decision reads, locked for its read-modify-write. */
export async function lockSiteForModeration(tx: Tx, siteId: string) {
  const [site] = await tx
    .select({
      id: sites.id,
      slug: sites.slug,
      status: sites.status,
      ownerId: sites.ownerId,
      currentVersionId: sites.currentVersionId,
      expiresAt: sites.expiresAt,
      purgeAfter: sites.purgeAfter,
      moderationReason: sites.moderationReason,
    })
    .from(sites)
    .where(eq(sites.id, siteId))
    .for("update");
  return site ?? null;
}

export type ModeratedSite = NonNullable<Awaited<ReturnType<typeof lockSiteForModeration>>>;

/**
 * The page's owner, read WITHOUT a lock — only to learn which `lockOwner` to
 * take before the row lock. `undefined`: no such page.
 */
export async function readSiteOwner(tx: Tx, siteId: string): Promise<string | null | undefined> {
  const [row] = await tx.select({ ownerId: sites.ownerId }).from(sites).where(eq(sites.id, siteId));
  return row ? row.ownerId : undefined;
}

/** Whether another page still claims `slug` (any status but archived / removed). */
export async function slugClaimedByAnother(tx: Tx, slug: string, siteId: string): Promise<boolean> {
  const [other] = await tx
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.slug, slug), claimsItsName(), ne(sites.id, siteId)))
    .limit(1);
  return other !== undefined;
}

/** The one status write: status, reason and (when given) the clocks, together. */
export async function writeModerationStatus(
  tx: Tx,
  siteId: string,
  change: {
    status: SiteStatus;
    moderationReason: ModerationReason | null;
    expiresAt?: Date | null;
    purgeAfter?: Date | null;
  },
): Promise<void> {
  await tx.update(sites).set(change).where(eq(sites.id, siteId));
}

export interface ModerationActionRow {
  siteId: string;
  slug: string;
  actor: ModerationActor;
  actorUserId: string | null;
  action: ModerationAction;
  fromStatus: SiteStatus;
  toStatus: SiteStatus | null;
  reason: ModerationReason | null;
  automated: boolean;
  note: string | null;
  /** The version the page served when the action was taken. */
  versionId: string | null;
  scanId: string | null;
  reportId: string | null;
  appealId: string | null;
}

/** Record one decision. Returns the row id. */
export async function insertModerationAction(tx: Tx, row: ModerationActionRow): Promise<string> {
  const [inserted] = await tx
    .insert(moderationActions)
    .values(row)
    .returning({ id: moderationActions.id });
  if (!inserted) throw new Error(`moderation_actions insert for site ${row.siteId} returned no row`);
  return inserted.id;
}

/**
 * Whether an admin's latest status decision on this version of the page put it
 * back live (a restore or a granted appeal). Report dismissals and appeal
 * rejections change no status, so they neither set nor clear it; an admin who
 * later hides or removes the same version clears it.
 */
export async function adminRestored(tx: Tx, siteId: string, versionId: string): Promise<boolean> {
  const [row] = await tx
    .select({ action: moderationActions.action })
    .from(moderationActions)
    .where(
      and(
        eq(moderationActions.siteId, siteId),
        eq(moderationActions.versionId, versionId),
        eq(moderationActions.actor, "admin"),
        isNotNull(moderationActions.toStatus),
      ),
    )
    .orderBy(desc(moderationActions.createdAt))
    .limit(1);
  return row?.action === "restore" || row?.action === "appeal_granted";
}

/**
 * Grant the site's open appeal — `appealId`'s when given, else whichever is
 * open (at most one: `appeals_site_open_key`). Returns the granted id, or
 * `null` when none was open.
 */
export async function grantOpenAppeal(
  tx: Tx,
  siteId: string,
  note: string | null,
  appealId?: string,
): Promise<string | null> {
  const [row] = await tx
    .update(appeals)
    .set({ status: "granted", decisionNote: note, decidedAt: sql`now()` })
    .where(
      and(
        eq(appeals.siteId, siteId),
        eq(appeals.status, "open"),
        ...(appealId ? [eq(appeals.id, appealId)] : []),
      ),
    )
    .returning({ id: appeals.id });
  return row?.id ?? null;
}

/**
 * Who the statement of reasons goes to: the owner's account address, else the
 * anonymous draft's `reminder_email`, else nobody (edge case 20).
 */
export async function statementRecipient(
  siteId: string,
): Promise<{ email: string | null; owned: boolean } | null> {
  const [row] = await db
    .select({ ownerId: sites.ownerId, accountEmail: user.email, reminderEmail: sites.reminderEmail })
    .from(sites)
    .leftJoin(user, eq(user.id, sites.ownerId))
    .where(eq(sites.id, siteId));
  if (!row) return null;
  return row.ownerId
    ? { email: row.accountEmail, owned: true }
    : { email: row.reminderEmail, owned: false };
}

/** The latest finished scan of one version, or `null` when it has none. */
export async function latestDoneScan(versionId: string) {
  const [row] = await db
    .select({ id: scans.id, verdict: scans.verdict, reason: scans.reason, rule: scans.rule })
    .from(scans)
    .where(and(eq(scans.versionId, versionId), eq(scans.status, "done")))
    .orderBy(desc(scans.createdAt))
    .limit(1);
  return row ?? null;
}

// ── appeals ──────────────────────────────────────────────────────────────────

/**
 * The page an appeal is about, locked so two submissions serialise. Owner-
 * scoped in the SQL when `ownerId` is given (the studio); unscoped for the
 * token holder, whose token the caller has already resolved to this id.
 */
export async function lockSiteForAppeal(tx: Tx, siteId: string, ownerId: string | null) {
  const [site] = await tx
    .select({
      id: sites.id,
      slug: sites.slug,
      status: sites.status,
      purgeAfter: sites.purgeAfter,
      moderationReason: sites.moderationReason,
    })
    .from(sites)
    .where(and(eq(sites.id, siteId), ...(ownerId ? [eq(sites.ownerId, ownerId)] : [])))
    .for("update");
  return site ?? null;
}

export async function hasOpenAppeal(tx: Tx, siteId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: appeals.id })
    .from(appeals)
    .where(and(eq(appeals.siteId, siteId), eq(appeals.status, "open")))
    .limit(1);
  return row !== undefined;
}

/** How many appeals the site has had since `since`, and the oldest of them. */
export async function appealsSince(
  tx: Tx,
  siteId: string,
  since: Date,
): Promise<{ count: number; oldest: Date | null }> {
  const where = and(eq(appeals.siteId, siteId), gt(appeals.createdAt, since));
  const [counted] = await tx.select({ n: count() }).from(appeals).where(where);
  const [oldest] = await tx
    .select({ createdAt: appeals.createdAt })
    .from(appeals)
    .where(where)
    .orderBy(asc(appeals.createdAt))
    .limit(1);
  return { count: counted?.n ?? 0, oldest: oldest?.createdAt ?? null };
}

export async function insertAppeal(
  tx: Tx,
  input: { siteId: string; submittedByUserId: string | null; message: string },
) {
  const [row] = await tx
    .insert(appeals)
    .values(input)
    .returning({ id: appeals.id, createdAt: appeals.createdAt });
  if (!row) throw new Error(`appeals insert for site ${input.siteId} returned no row`);
  return row;
}

export async function findAppeal(appealId: string) {
  const [row] = await db
    .select({ id: appeals.id, siteId: appeals.siteId, status: appeals.status })
    .from(appeals)
    .where(eq(appeals.id, appealId));
  return row ?? null;
}

/** Reject `appealId` if it is still open. Returns its site, or `null` when it was not open. */
export async function rejectOpenAppeal(tx: Tx, appealId: string, note: string) {
  const [row] = await tx
    .update(appeals)
    .set({ status: "rejected", decisionNote: note, decidedAt: sql`now()` })
    .where(and(eq(appeals.id, appealId), eq(appeals.status, "open")))
    .returning({ siteId: appeals.siteId });
  return row ?? null;
}

/**
 * Reject every open appeal on `siteIds` with `note` — account deletion (D-68):
 * nobody is left to hear the decision, and purge waits on an open appeal
 * (edge case 24), so one left open would keep the page's bytes forever.
 */
export async function rejectOpenAppealsOn(tx: Tx, siteIds: readonly string[], note: string): Promise<void> {
  if (siteIds.length === 0) return;
  await tx
    .update(appeals)
    .set({ status: "rejected", decisionNote: note, decidedAt: sql`now()` })
    .where(and(inArray(appeals.siteId, [...siteIds]), eq(appeals.status, "open")));
}
