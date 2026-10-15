/**
 * Taking a report (E07 D10, §6.8) — `POST /api/reports`. The route is the HTTP
 * boundary; this module decides, in this order:
 *
 *   1. per-IP limits, two rules (every request counts, malformed ones too) → 429
 *   2. the body (`reportRequestSchema`)                                   → 400 invalid
 *   3. Turnstile                                                          → 400 turnstile_failed
 *   4. the link → a page (`findReportTarget`)                             → 422 not_a_kept_page
 *   5. the row: `duplicate` (same page + reporter bucket within 24 h),
 *      closed on arrival (the page is `archived` / `removed`), else `open`
 *   6. the effects, below                                                 → 201 { ok }
 *
 * EFFECTS of a new (not duplicate) report on a page still up:
 *   · child sexual abuse material → `setStatus(quarantined)` at once, whose own
 *     alert is the PRIORITY mail (AC17). Only from `live` / `under_review`; when
 *     the edge is refused (already hidden, expired) a PRIORITY report alert
 *     goes instead — never deduplicated.
 *   · any other category → one admin alert per page per hour (`report-alert:<siteId>`).
 *   · a re-scan of the current version, unless a `done` scan of it is < 24 h old.
 * A report on a page that is already gone is stored, closed "already removed"
 * (edge case 11) and alerts nobody — except CSAM, which is always PRIORITY.
 * A duplicate alerts nobody and re-scans nothing; a CSAM duplicate still runs
 * the fast path, so a page is never left up because the same reporter first
 * picked another category.
 *
 * REPORTER IDENTITY. `reporter_bucket` is `ipKey`'s digest — salted daily, never
 * the raw address. Because the salt turns over at 00:00 UTC, the 24 h collapse
 * checks today's and yesterday's digest. Name and email are stored only when
 * given, and the receipt goes only to a given email. Nothing here logs either.
 */
import {
  RATE_LIMITS,
  REPORT_ALERT_PER_SITE_HOUR,
  REPORT_DUPLICATE_WINDOW_HOURS,
  REPORT_RESCAN_FRESH_HOURS,
  reportRequestSchema,
  type ReportErrorCode,
  type ReportStatus,
} from "@kept/shared";

import {
  findReportTarget,
  insertReport,
  reportedRecently,
  scannedWithin,
  type ReportTarget,
} from "../db/queries/reports";
import { sendAdminAlert, type AdminAlertOutcome } from "../email/admin-alert";
import {
  ALREADY_REMOVED_NOTE,
  reportAlert,
  sendReportDecision,
  sendReportReceipt,
  type ReporterMailOutcome,
} from "../email/reports";
import { setStatus, type SetStatusResult } from "../moderation/status";
import { enqueueScan, verifyTurnstile } from "../publish/hooks";
import { liveUrl } from "../publish/pipeline";
import { hit, ipKey } from "../rate-limit";
import { MS_PER_DAY } from "../sites/display";
import { appOrigin, servingBaseDomain } from "../storage/env";

import { reportedSlug } from "./url";

/** The per-IP buckets' route: `report:<digest>` (hour) and `report:<digest>:day`. */
const REPORT_ROUTE = "report";

export type ReportRefusal =
  | { ok: false; code: Exclude<ReportErrorCode, "rate_limited"> }
  | { ok: false; code: "rate_limited"; retryAfterSeconds: number };

/** What happened — the route answers `{ ok: true }`; the rest is for tests and logs. */
export interface ReportAccepted {
  ok: true;
  reportId: string;
  siteId: string;
  status: ReportStatus;
  /** The CSAM fast path's `setStatus` result, when it ran. */
  hidden: SetStatusResult | null;
  /** The report alert this module sent; `null` when none was due (a hide's own alert is in `hidden`). */
  alert: AdminAlertOutcome | null;
  /** The version a re-scan was enqueued for. */
  rescanned: string | null;
  /** The receipt, or — for a report closed on arrival — the decision. */
  reporterMail: ReporterMailOutcome;
}

export type ReportOutcome = ReportAccepted | ReportRefusal;

const GONE = new Set(["archived", "removed"]);
const FAST_PATH_FROM = new Set(["live", "under_review"]);

/** The 24 h collapse: today's and yesterday's digest of this address. */
async function reporterBuckets(clientIp: string, now: Date): Promise<[string, string]> {
  return [
    await ipKey(REPORT_ROUTE, clientIp, now),
    await ipKey(REPORT_ROUTE, clientIp, new Date(now.getTime() - MS_PER_DAY)),
  ];
}

/** Re-scan the current version unless it was scanned within the window. Fire and forget (D2). */
async function rescan(site: ReportTarget): Promise<string | null> {
  if (!site.currentVersionId) return null;
  if (await scannedWithin(site.currentVersionId, REPORT_RESCAN_FRESH_HOURS)) return null;
  void enqueueScan(site.id, site.currentVersionId, "report");
  return site.currentVersionId;
}

export async function submitReport(raw: unknown, clientIp: string): Promise<ReportOutcome> {
  const now = new Date();
  const [bucket, yesterdaysBucket] = await reporterBuckets(clientIp, now);

  // Two rules, two buckets: windows are epoch-aligned, so an hour and a day
  // on one bucket would share the row that starts at 00:00 UTC.
  for (const [key, rule] of [
    [bucket, RATE_LIMITS.reportPerIpHour],
    [`${bucket}:day`, RATE_LIMITS.reportPerIpDay],
  ] as const) {
    const limited = await hit(key, rule);
    if (!limited.allowed) return { ok: false, code: "rate_limited", retryAfterSeconds: limited.retryAfterSeconds };
  }

  const parsed = reportRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "invalid" };
  const body = parsed.data;

  if (!(await verifyTurnstile(body.turnstileToken, clientIp)).ok) return { ok: false, code: "turnstile_failed" };

  const slug = reportedSlug(body.url, servingBaseDomain());
  const site = slug ? await findReportTarget(slug) : null;
  if (!site) return { ok: false, code: "not_a_kept_page" };

  const duplicate = await reportedRecently(site.id, [bucket, yesterdaysBucket], REPORT_DUPLICATE_WINDOW_HOURS);
  const gone = GONE.has(site.status);
  const status: ReportStatus = duplicate ? "duplicate" : gone ? "dismissed" : "open";
  const closedOnArrival = status === "dismissed";

  const reportId = await insertReport({
    siteId: site.id,
    slug: site.slug,
    url: body.url,
    category: body.category,
    details: body.details,
    reporterName: body.name ?? null,
    reporterEmail: body.email ?? null,
    reporterBucket: bucket,
    status,
    resolutionNote: closedOnArrival ? ALREADY_REMOVED_NOTE : null,
    resolvedAt: closedOnArrival ? now : null,
  });

  const csam = body.category === "child_sexual_abuse";
  const hidden =
    csam && FAST_PATH_FROM.has(site.status)
      ? await setStatus(site.id, "quarantined", {
          actor: "report",
          reason: "child_sexual_abuse",
          automated: true,
          reportId,
        })
      : null;

  let alert: AdminAlertOutcome | null = null;
  if (!duplicate && !hidden?.ok && (csam || !gone)) {
    const message = reportAlert({
      reportId,
      slug: site.slug,
      pageUrl: liveUrl(site.slug),
      status: site.status,
      category: body.category,
      details: body.details,
      origin: appOrigin(),
    });
    alert = await sendAdminAlert(
      csam ? message : { ...message, throttleKey: `report-alert:${site.id}`, throttle: REPORT_ALERT_PER_SITE_HOUR },
    );
  }

  const rescanned = duplicate || gone ? null : await rescan(site);

  const reporterMail = closedOnArrival
    ? await sendReportDecision(reportId)
    : await sendReportReceipt({ id: reportId, url: body.url, reporterEmail: body.email ?? null });

  return { ok: true, reportId, siteId: site.id, status, hidden, alert, rescanned, reporterMail };
}
