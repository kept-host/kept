/**
 * Report mail (E07 §6.8, AC18): the reporter's receipt, the reporter's decision
 * mail, and the admin alert for a new report.
 *
 * A REPORTER IS MAILED ONLY WHEN THEY GAVE AN ADDRESS. The receipt goes out the
 * moment the report is stored; the decision when the report is resolved — the
 * admin screen (task 011) calls `sendReportDecision(reportId)` after it closes
 * one, and a report closed on arrival (the page was already gone, edge case 11)
 * gets it at once. Neither ever names what a scan found, a rule or a
 * probability (§9); the decision says whether automated means were used.
 *
 * The builders are pure; the senders never throw and log no address.
 */
import {
  ABUSE_CONTACT_EMAIL,
  REPORT_CATEGORIES,
  type ModerationReason,
  type SiteStatus,
} from "@kept/shared";

import { automatedMeansUsed, readReport, type StoredReport } from "../db/queries/reports";
import { appOrigin } from "../storage/env";
import type { AdminAlert } from "./admin-alert";
import { emailFooter } from "./footer";
import { sendModerationEmail, type ModerationEmail } from "./moderation";

/** `resolution_note` of a report closed on arrival because its page was already gone. */
export const ALREADY_REMOVED_NOTE = "already removed";

function withFooter(paragraphs: string[], from: string, origin: string): string {
  return `${paragraphs.join("\n\n")}\n\n${emailFooter({ from, origin }).text}`;
}

/** The receipt (§6.8). Pure. */
export function buildReportReceipt(input: { url: string; from: string; origin: string }): ModerationEmail {
  return {
    subject: "We've got your report",
    text: withFooter(
      [
        `Thanks for reporting ${input.url}. We've got it.`,
        "We'll look at the page and act if it breaks our rules. We'll email you what we decide.",
        `Anything to add? Write to ${ABUSE_CONTACT_EMAIL}.`,
      ],
      input.from,
      input.origin,
    ),
  };
}

export type DecisionOutcome = "actioned" | "dismissed" | "already_removed";

function decisionLead(outcome: DecisionOutcome, url: string): string {
  switch (outcome) {
    case "actioned":
      return `We looked at your report about ${url} and took the page down.`;
    case "dismissed":
      return `We looked at your report about ${url}. We didn't find that it breaks our rules, so the page stays up.`;
    case "already_removed":
      return `The page you reported, ${url}, had already been taken down, so there was nothing more to do.`;
  }
}

/** Whether automated means were used (DSA Art. 16(6)) — never what they found. */
function howDecided(outcome: DecisionOutcome, automated: boolean): string {
  if (outcome === "already_removed") {
    return "How we decided: your report was closed automatically, because the page was already gone.";
  }
  return automated
    ? "How we decided: automated checks were used in handling your report, and a person made the decision."
    : "How we decided: a person reviewed it. No automated means were used.";
}

/** The decision (§6.8, AC18), including whether automated means were used. Pure. */
export function buildReportDecision(input: {
  url: string;
  outcome: DecisionOutcome;
  /** The reviewer's note; shown only on a decision a person made. */
  note: string | null;
  automated: boolean;
  from: string;
  origin: string;
}): ModerationEmail {
  const paragraphs = [decisionLead(input.outcome, input.url)];
  if (input.outcome !== "already_removed" && input.note) {
    paragraphs.push(`A note from the person who reviewed it: ${input.note}`);
  }
  paragraphs.push(howDecided(input.outcome, input.automated), `Questions? Write to ${ABUSE_CONTACT_EMAIL}.`);
  return { subject: "About the page you reported", text: withFooter(paragraphs, input.from, input.origin) };
}

export type ReporterMailOutcome = "sent" | "no_email" | "not_resolved" | "not_found" | "failed";

async function mailReporter(
  report: Pick<StoredReport, "id" | "reporterEmail">,
  build: (from: string) => ModerationEmail,
): Promise<ReporterMailOutcome> {
  if (!report.reporterEmail) return "no_email";
  try {
    await sendModerationEmail(report.reporterEmail, build);
    return "sent";
  } catch (err) {
    console.error(
      `[kept] report mail for report ${report.id} not sent — ${err instanceof Error ? err.message : String(err)}`,
    );
    return "failed";
  }
}

/** The receipt to the reporter, if they gave an address. Never throws. */
export function sendReportReceipt(report: Pick<StoredReport, "id" | "url" | "reporterEmail">): Promise<ReporterMailOutcome> {
  return mailReporter(report, (from) => buildReportReceipt({ url: report.url, from, origin: appOrigin() }));
}

/**
 * The decision to the reporter of `reportId`, if they gave an address and the
 * report is resolved (`actioned` / `dismissed`). An `open` report has no
 * decision yet, and a `duplicate` was the same reporter's second word on a
 * page their first report already covers. Never throws.
 */
export async function sendReportDecision(reportId: string): Promise<ReporterMailOutcome> {
  let report: StoredReport | null;
  let automated: boolean;
  try {
    report = await readReport(reportId);
    if (!report) return "not_found";
    if (report.status !== "actioned" && report.status !== "dismissed") return "not_resolved";
    if (!report.reporterEmail) return "no_email";
    automated = await automatedMeansUsed(report);
  } catch (err) {
    console.error(
      `[kept] report decision for report ${reportId} not sent — ${err instanceof Error ? err.message : String(err)}`,
    );
    return "failed";
  }
  const outcome: DecisionOutcome =
    report.status === "actioned"
      ? "actioned"
      : report.resolutionNote === ALREADY_REMOVED_NOTE
        ? "already_removed"
        : "dismissed";
  const { url, resolutionNote } = report;
  return mailReporter(report, (from) =>
    buildReportDecision({ url, outcome, note: resolutionNote, automated, from, origin: appOrigin() }),
  );
}

const CATEGORY_LABELS = Object.fromEntries(REPORT_CATEGORIES.map(({ reason, label }) => [reason, label])) as Record<
  ModerationReason,
  string
>;

/**
 * The admin alert for a new report (§6.8). Throttled per page per hour by the
 * caller, except for child sexual abuse material: PRIORITY, never deduplicated.
 * The reporter's words go to Arun; their name, email and address never do.
 */
export function reportAlert(input: {
  reportId: string;
  slug: string;
  pageUrl: string;
  status: SiteStatus;
  category: ModerationReason;
  details: string;
  origin: string;
}): Omit<AdminAlert, "throttleKey" | "throttle"> {
  return {
    subject: `Report on ${input.slug}: ${CATEGORY_LABELS[input.category]}`,
    priority: input.category === "child_sexual_abuse",
    lines: [
      `Page: ${input.pageUrl}`,
      `Status: ${input.status}`,
      `What's wrong: ${CATEGORY_LABELS[input.category]}`,
      `Their words:\n${input.details}`,
      `Report: ${input.reportId}`,
      `Review it: ${input.origin}/admin/moderation`,
    ],
  };
}
