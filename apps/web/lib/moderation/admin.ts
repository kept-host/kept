/**
 * The moderation screen's decisions (E07 §6.11, AC21) — what each admin action
 * does, on top of the modules that own the writes:
 *
 *   Restore · Hide · Remove   → `setStatus` (status, reason, clocks, D19 hold,
 *                               manifest, action row, statement of reasons);
 *                               Hide and Remove then close the page's open
 *                               reports as `actioned` and mail the reporters.
 *   Dismiss report(s)         → the reports closed as `dismissed` with the note,
 *                               one `dismiss_report` row each, reporter mails.
 *   Grant / Reject appeal     → `grantAppeal` / `rejectAppeal`.
 *
 * Every function takes an already-validated body (`./admin-rules.ts`) and the
 * admin's user id; the routes have already passed the origin gate and the
 * admin check. Mail never throws; outcomes are returned, not logged with
 * addresses.
 */
import type { ModerationReason, SiteStatus } from "@kept/shared";

import { db, type Tx } from "../db";
import { insertModerationAction } from "../db/queries/moderation";
import { sourceSubject } from "../db/queries/moderation-screen";
import { resolveOpenReports } from "../db/queries/reports";
import { sendReportDecision, type ReporterMailOutcome } from "../email/reports";
import type { ModeratedStatus } from "../email/moderation";
import { pageObjectKey, r2Store } from "../storage/r2";

import type { SiteAction } from "./admin-rules";
import { grantAppeal, rejectAppeal, type RejectAppealResult } from "./appeals";
import { withholdsBytes } from "./restriction";
import { isAllowedTransition, setStatus, type SetStatusResult } from "./status";

const TARGET: Record<SiteAction, ModeratedStatus> = {
  restore: "live",
  hide: "quarantined",
  remove: "removed",
};

/** Which site actions the transition table allows an admin from `status`. */
export function allowedSiteActions(status: SiteStatus): Record<SiteAction, boolean> {
  // An admin's edges carry no reason restriction; any reason answers for them.
  const allowed = (action: SiteAction) => isAllowedTransition(status, TARGET[action], "admin", "other");
  return { restore: allowed("restore"), hide: allowed("hide"), remove: allowed("remove") };
}

export interface ReportsClosed {
  closed: number;
  mails: ReporterMailOutcome[];
}

/** The decision mail to each closed report's reporter (sequential: a handful at most). */
async function mailReporters(reportIds: string[]): Promise<ReporterMailOutcome[]> {
  const mails: ReporterMailOutcome[] = [];
  for (const id of reportIds) mails.push(await sendReportDecision(id));
  return mails;
}

export type SiteActionResult = { status: SetStatusResult; reports: ReportsClosed };

/** Restore, Hide or Remove one page. */
export async function moderateSite(
  siteId: string,
  body: { action: SiteAction; reason?: ModerationReason; note?: string },
  adminUserId: string,
): Promise<SiteActionResult> {
  const status = await setStatus(siteId, TARGET[body.action], {
    actor: "admin",
    automated: false,
    reason: body.action === "restore" ? undefined : body.reason,
    note: body.note,
    actorUserId: adminUserId,
  });
  if (!status.ok || body.action === "restore") return { status, reports: { closed: 0, mails: [] } };

  const closed = await db.transaction((tx) => resolveOpenReports(tx, { siteId }, "actioned", body.note ?? null));
  return { status, reports: { closed: closed.length, mails: await mailReporters(closed.map((row) => row.id)) } };
}

/** Log one `dismiss_report` row per closed report whose page still exists. */
async function logDismissals(
  tx: Tx,
  closed: Awaited<ReturnType<typeof resolveOpenReports>>,
  note: string,
  adminUserId: string,
): Promise<void> {
  for (const row of closed) {
    if (!row.siteId || !row.siteStatus) continue;
    await insertModerationAction(tx, {
      siteId: row.siteId,
      slug: row.slug,
      actor: "admin",
      actorUserId: adminUserId,
      action: "dismiss_report",
      fromStatus: row.siteStatus,
      toStatus: null,
      reason: row.category,
      automated: false,
      note,
      versionId: null,
      scanId: null,
      reportId: row.id,
      appealId: null,
    });
  }
}

/** Dismiss open reports. Reports already closed are skipped, not refused. */
export async function dismissReports(reportIds: string[], note: string, adminUserId: string): Promise<ReportsClosed> {
  const closed = await db.transaction(async (tx) => {
    const rows = await resolveOpenReports(tx, { reportIds }, "dismissed", note);
    await logDismissals(tx, rows, note, adminUserId);
    return rows;
  });
  return { closed: closed.length, mails: await mailReporters(closed.map((row) => row.id)) };
}

export type AppealDecisionResult =
  | { decision: "grant"; result: SetStatusResult }
  | { decision: "reject"; result: RejectAppealResult };

/** Grant (restore the page) or reject an open appeal. */
export async function decideAppeal(
  appealId: string,
  body: { decision: "grant" | "reject"; note: string },
  adminUserId: string,
): Promise<AppealDecisionResult> {
  return body.decision === "grant"
    ? { decision: "grant", result: await grantAppeal(appealId, adminUserId, body.note) }
    : { decision: "reject", result: await rejectAppeal(appealId, adminUserId, body.note) };
}

/**
 * The page's current HTML from R2, whole, for the admin preview — or `null`
 * when it has no version or the read failed. Never throws.
 *
 * Not `readPreviewHtml`: that reader withholds child-sexual-abuse pages from
 * every owner screen (D13) and caps the size for the studio. Here the caller
 * decides — the item view never calls this for such a page until "Show".
 */
export async function readAdminHtml(site: { id: string; slug: string; currentVersionId: string | null }) {
  if (!site.currentVersionId) return null;
  try {
    return await r2Store().get(pageObjectKey(site.id, site.currentVersionId));
  } catch (err) {
    console.error(
      `[kept] admin preview: read failed for site ${site.id} (slug "${site.slug}") — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * The bytes the item view's Preview and Source round-trips serve, or `null`
 * (no such page, nothing readable). A child-sexual-abuse item's only when the
 * request carries the "Show" click's intent (`shown`, D13): the item view never
 * names such a URL until Arun asks.
 */
export async function readAdminPageHtml(siteId: string, shown: boolean): Promise<string | null> {
  const site = await sourceSubject(siteId);
  if (!site || (withholdsBytes(site) && !shown)) return null;
  return readAdminHtml(site);
}
