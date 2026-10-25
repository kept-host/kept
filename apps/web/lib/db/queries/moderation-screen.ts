/**
 * Every read of the moderation screen (E07 §6.11, task 011) — the six tabs and
 * the item view. Read-only: every write is `lib/moderation`'s or
 * `lib/reports`'s. Kept apart from `./moderation.ts`, whose statements are the
 * locked read-modify-writes of `setStatus`.
 *
 * Owner and reporter addresses are admin-only data: they leave here for the
 * admin screen and nowhere else, and are never logged.
 */
import { and, asc, desc, eq, gt, inArray, sql, sum } from "drizzle-orm";

import { db } from "../index";
import { abuseReports, appeals, moderationActions, scans, sites, siteVersions, user } from "../schema";
import { versionFiles } from "./version-files";

/** Rows per page of the Log tab. */
export const LOG_PAGE_SIZE = 40;

/** The Queue and Reports tabs read at most this many rows. */
const TAB_LIMIT = 200;

/** When the page entered its current status: its latest moderation action. */
const flaggedAt = sql<Date | null>`(
  select max(${moderationActions.createdAt}) from ${moderationActions}
  where ${moderationActions.siteId} = ${sites.id}
)`.mapWith(sites.createdAt);

const openReportCount = sql<number>`(
  select count(*) from ${abuseReports}
  where ${abuseReports.siteId} = ${sites.id} and ${abuseReports.status} = 'open'
)`.mapWith(Number);

const hasOpenAppeal = sql<boolean>`exists (
  select 1 from ${appeals} where ${appeals.siteId} = ${sites.id} and ${appeals.status} = 'open'
)`.mapWith(Boolean);

/**
 * Whose page it is, as every row and the item view name it: the owner's
 * address; `no owner` for a page that was an account's until the account was
 * deleted (D-68 — `claimed_at` outlives `owner_id`); else `anonymous`, with the
 * draft's reminder address when the publisher left one. Needs `user`
 * left-joined on `sites.owner_id` (`withOwner`). `null` only where the page
 * itself is gone (a report's purged page).
 */
const owner = sql<string | null>`case
  when ${sites.id} is null then null
  when ${sites.ownerId} is not null then coalesce(${user.email}, 'account without an address')
  when ${sites.claimedAt} is not null then 'no owner'
  when ${sites.reminderEmail} is not null then 'anonymous · ' || ${sites.reminderEmail}
  else 'anonymous'
end`;
const withOwner = eq(user.id, sites.ownerId);

/**
 * Queue: every `under_review` and `quarantined` page, child sexual abuse
 * material pinned on top, then oldest first (by when it entered the status).
 */
export async function queueItems() {
  return db
    .select({
      id: sites.id,
      slug: sites.slug,
      status: sites.status,
      reason: sites.moderationReason,
      draft: sql<boolean>`${sites.expiresAt} is not null`.mapWith(Boolean),
      flaggedAt,
      openReports: openReportCount,
      openAppeal: hasOpenAppeal,
      owner,
    })
    .from(sites)
    .leftJoin(user, withOwner)
    .where(inArray(sites.status, ["under_review", "quarantined"]))
    .orderBy(
      sql`${sites.moderationReason} = 'child_sexual_abuse' is true desc`,
      sql`coalesce(${flaggedAt}, ${sites.updatedAt}) asc`,
    )
    .limit(TAB_LIMIT);
}

/** Reports: every open report, oldest first, with its page's status (if the page still exists). */
export async function openReports() {
  return db
    .select({
      id: abuseReports.id,
      siteId: abuseReports.siteId,
      slug: abuseReports.slug,
      url: abuseReports.url,
      category: abuseReports.category,
      details: abuseReports.details,
      createdAt: abuseReports.createdAt,
      siteStatus: sites.status,
      owner,
    })
    .from(abuseReports)
    .leftJoin(sites, eq(sites.id, abuseReports.siteId))
    .leftJoin(user, withOwner)
    .where(eq(abuseReports.status, "open"))
    .orderBy(asc(abuseReports.createdAt))
    .limit(TAB_LIMIT);
}

/** Appeals: every open appeal, oldest first. */
export async function openAppeals() {
  return db
    .select({
      id: appeals.id,
      siteId: appeals.siteId,
      slug: sites.slug,
      siteStatus: sites.status,
      reason: sites.moderationReason,
      message: appeals.message,
      anonymous: sql<boolean>`${appeals.submittedByUserId} is null`.mapWith(Boolean),
      createdAt: appeals.createdAt,
      owner,
    })
    .from(appeals)
    .innerJoin(sites, eq(sites.id, appeals.siteId))
    .leftJoin(user, withOwner)
    .where(eq(appeals.status, "open"))
    .orderBy(asc(appeals.createdAt))
    .limit(TAB_LIMIT);
}

/** Watch: the traffic-spike re-scans of the last `days` days, newest first. */
export async function spikeScans(days: number) {
  return db
    .select({
      id: scans.id,
      siteId: scans.siteId,
      slug: sites.slug,
      siteStatus: sites.status,
      status: scans.status,
      verdict: scans.verdict,
      reason: scans.reason,
      createdAt: scans.createdAt,
      owner,
    })
    .from(scans)
    .innerJoin(sites, eq(sites.id, scans.siteId))
    .leftJoin(user, withOwner)
    .where(
      and(eq(scans.trigger, "traffic_spike"), gt(scans.createdAt, sql`now() - make_interval(days => ${days})`)),
    )
    .orderBy(desc(scans.createdAt))
    .limit(TAB_LIMIT);
}

const actionColumns = {
  id: moderationActions.id,
  siteId: moderationActions.siteId,
  slug: moderationActions.slug,
  actor: moderationActions.actor,
  action: moderationActions.action,
  fromStatus: moderationActions.fromStatus,
  toStatus: moderationActions.toStatus,
  reason: moderationActions.reason,
  automated: moderationActions.automated,
  note: moderationActions.note,
  createdAt: moderationActions.createdAt,
};

/** Log: every moderation action, newest first, one page (`page` from 1) at a time. */
export async function actionLog(page: number) {
  const rows = await db
    .select(actionColumns)
    .from(moderationActions)
    .orderBy(desc(moderationActions.createdAt), desc(moderationActions.id))
    .limit(LOG_PAGE_SIZE + 1)
    .offset((page - 1) * LOG_PAGE_SIZE);
  return { rows: rows.slice(0, LOG_PAGE_SIZE), hasMore: rows.length > LOG_PAGE_SIZE };
}

/** Classifier spend over the last `days` days, in USD, from `scans.cost_usd`. */
export async function scanSpendUsd(days: number): Promise<number> {
  const [row] = await db
    .select({ total: sum(scans.costUsd) })
    .from(scans)
    .where(gt(scans.createdAt, sql`now() - make_interval(days => ${days})`));
  return Number(row?.total ?? 0);
}

/**
 * The item view: one page with everything a decision needs — who owns it,
 * through which channel its current version came, the latest scan of that
 * version, its reports, its appeals and its moderation timeline. `null`: no
 * such page (purged, or never existed).
 *
 * `files` lists the current version's set from `site_version_files` (never an
 * R2 list) when it has more than one file — the preview frames only
 * `index.html`, so this is how a moderator sees the scripts and binaries the
 * page also ships. Empty for a single-file page.
 */
export async function moderationItem(siteId: string) {
  const [site] = await db
    .select({
      id: sites.id,
      slug: sites.slug,
      status: sites.status,
      reason: sites.moderationReason,
      expiresAt: sites.expiresAt,
      purgeAfter: sites.purgeAfter,
      createdAt: sites.createdAt,
      currentVersionId: sites.currentVersionId,
      sizeBytes: sites.sizeBytes,
      owner,
      channel: siteVersions.publishedVia,
      fileCount: siteVersions.fileCount,
    })
    .from(sites)
    .leftJoin(user, withOwner)
    .leftJoin(siteVersions, eq(siteVersions.id, sites.currentVersionId))
    .where(eq(sites.id, siteId));
  if (!site) return null;

  const [scan] = site.currentVersionId
    ? await db
        .select({
          id: scans.id,
          trigger: scans.trigger,
          status: scans.status,
          verdict: scans.verdict,
          rule: scans.rule,
          reason: scans.reason,
          model: scans.model,
          policyVersion: scans.policyVersion,
          answers: scans.answers,
          facts: scans.facts,
          error: scans.error,
          createdAt: scans.createdAt,
        })
        .from(scans)
        .where(eq(scans.versionId, site.currentVersionId))
        .orderBy(desc(scans.createdAt))
        .limit(1)
    : [];

  const [reports, siteAppeals, timeline, files] = await Promise.all([
    db
      .select({
        id: abuseReports.id,
        category: abuseReports.category,
        details: abuseReports.details,
        status: abuseReports.status,
        resolutionNote: abuseReports.resolutionNote,
        createdAt: abuseReports.createdAt,
      })
      .from(abuseReports)
      .where(eq(abuseReports.siteId, siteId))
      .orderBy(desc(abuseReports.createdAt)),
    db
      .select({
        id: appeals.id,
        message: appeals.message,
        status: appeals.status,
        decisionNote: appeals.decisionNote,
        anonymous: sql<boolean>`${appeals.submittedByUserId} is null`.mapWith(Boolean),
        createdAt: appeals.createdAt,
      })
      .from(appeals)
      .where(eq(appeals.siteId, siteId))
      .orderBy(desc(appeals.createdAt)),
    db
      .select(actionColumns)
      .from(moderationActions)
      .where(eq(moderationActions.siteId, siteId))
      .orderBy(asc(moderationActions.createdAt)),
    site.currentVersionId && (site.fileCount ?? 1) > 1 ? versionFiles(db, site.currentVersionId) : [],
  ]);

  return { site, scan: scan ?? null, reports, appeals: siteAppeals, timeline, files };
}

export type ModerationItem = NonNullable<Awaited<ReturnType<typeof moderationItem>>>;


/** What the Preview and Source round-trips need to read a page's bytes; `null`: no such page. */
export async function sourceSubject(siteId: string) {
  const [site] = await db
    .select({
      id: sites.id,
      slug: sites.slug,
      currentVersionId: sites.currentVersionId,
      moderationReason: sites.moderationReason,
    })
    .from(sites)
    .where(eq(sites.id, siteId));
  return site ?? null;
}
