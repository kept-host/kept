/**
 * Every SQL statement `lib/reports` and `lib/email/reports.ts` run (E07 §6.8).
 * No decisions here — which row a link means, what counts as a duplicate and
 * which mails go out are `lib/reports/submit.ts`'s.
 */
import type { ModerationReason, ReportStatus } from "@kept/shared";
import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";

import { db } from "../index";
import { abuseReports, moderationActions, scans, sites } from "../schema";

/**
 * The page a reported slug means. `sites_slug_key` is partial (it excludes
 * `archived` and `removed`), so one slug can name several rows: the row that
 * still claims the slug wins; otherwise the most recently changed `archived` /
 * `removed` row not yet purged (edge case 11). `null`: nothing — purged or
 * never published.
 */
export async function findReportTarget(slug: string) {
  const [site] = await db
    .select({
      id: sites.id,
      slug: sites.slug,
      status: sites.status,
      currentVersionId: sites.currentVersionId,
    })
    .from(sites)
    .where(eq(sites.slug, slug))
    .orderBy(sql`${sites.status} in ('archived', 'removed')`, desc(sites.updatedAt))
    .limit(1);
  return site ?? null;
}

export type ReportTarget = NonNullable<Awaited<ReturnType<typeof findReportTarget>>>;

/**
 * Whether one of `buckets` reported `siteId` within the last `hours`. Several
 * buckets because a bucket's salt turns over at 00:00 UTC: the caller passes
 * today's and yesterday's digest of the same address.
 */
export async function reportedRecently(siteId: string, buckets: string[], hours: number): Promise<boolean> {
  const [row] = await db
    .select({ id: abuseReports.id })
    .from(abuseReports)
    .where(
      and(
        eq(abuseReports.siteId, siteId),
        inArray(abuseReports.reporterBucket, buckets),
        gt(abuseReports.createdAt, sql`now() - make_interval(hours => ${hours})`),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export interface NewReport {
  siteId: string;
  slug: string;
  url: string;
  category: ModerationReason;
  details: string;
  reporterName: string | null;
  reporterEmail: string | null;
  reporterBucket: string;
  status: ReportStatus;
  /** Set together with `resolvedAt` when the report is closed on arrival. */
  resolutionNote: string | null;
  resolvedAt: Date | null;
}

export async function insertReport(report: NewReport): Promise<string> {
  const [row] = await db.insert(abuseReports).values(report).returning({ id: abuseReports.id });
  if (!row) throw new Error("abuse_reports insert returned no row");
  return row.id;
}

/** Whether `versionId` has a `done` scan that finished within the last `hours`. */
export async function scannedWithin(versionId: string, hours: number): Promise<boolean> {
  const [row] = await db
    .select({ id: scans.id })
    .from(scans)
    .where(
      and(
        eq(scans.versionId, versionId),
        eq(scans.status, "done"),
        gt(
          sql`coalesce(${scans.completedAt}, ${scans.createdAt})`,
          sql`now() - make_interval(hours => ${hours})`,
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** One report, as the reporter mails need it. */
export async function readReport(reportId: string) {
  const [row] = await db
    .select({
      id: abuseReports.id,
      siteId: abuseReports.siteId,
      slug: abuseReports.slug,
      url: abuseReports.url,
      status: abuseReports.status,
      resolutionNote: abuseReports.resolutionNote,
      reporterEmail: abuseReports.reporterEmail,
      createdAt: abuseReports.createdAt,
    })
    .from(abuseReports)
    .where(eq(abuseReports.id, reportId));
  return row ?? null;
}

export type StoredReport = NonNullable<Awaited<ReturnType<typeof readReport>>>;

/**
 * Whether automated means took part in handling `report` (DSA Art. 16(6)): an
 * automated moderation step taken on its page since it arrived (the report fast
 * path, the scanner) or a report-triggered scan of the page since then.
 */
export async function automatedMeansUsed(report: Pick<StoredReport, "id" | "siteId" | "createdAt">): Promise<boolean> {
  const sinceReport = report.siteId
    ? or(
        eq(moderationActions.reportId, report.id),
        and(eq(moderationActions.siteId, report.siteId), gt(moderationActions.createdAt, report.createdAt)),
      )
    : eq(moderationActions.reportId, report.id);
  const [action] = await db
    .select({ id: moderationActions.id })
    .from(moderationActions)
    .where(and(eq(moderationActions.automated, true), sinceReport))
    .limit(1);
  if (action) return true;
  if (!report.siteId) return false;

  const [scan] = await db
    .select({ id: scans.id })
    .from(scans)
    .where(and(eq(scans.siteId, report.siteId), eq(scans.trigger, "report"), gt(scans.createdAt, report.createdAt)))
    .limit(1);
  return scan !== undefined;
}
