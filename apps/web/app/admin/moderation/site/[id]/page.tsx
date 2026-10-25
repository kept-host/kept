/**
 * `/admin/moderation/site/[id]` — the item view (E07 §6.11): the facts, why it
 * was flagged, the page itself (sandboxed preview + escaped Source), its
 * reports, its appeal, its timeline, and the decisions.
 *
 * The page's HTML is read from R2 HERE, server-side, for the escaped Source;
 * the Preview frame reads it again from its own sandboxed route (D-69) — never
 * markup on an `app.` document. A child-sexual-abuse item reads nothing here
 * (D13): its bytes leave only through "Show".
 *
 * A multi-file page also lists its current version's files under the preview —
 * path, size and the type the edge serves it as, from Postgres alone — since
 * the preview shows `index.html` with no network and the rest of the set would
 * otherwise be invisible. Withheld with the bytes on a child-sexual-abuse item.
 */
import { DRAFT_GRACE_DAYS } from "@kept/shared";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { getAdminSession } from "@/lib/auth/admin";
import { moderationItem } from "@/lib/db/queries/moderation-screen";
import { allowedSiteActions, readAdminHtml } from "@/lib/moderation/admin";
import { withholdsBytes } from "@/lib/moderation/restriction";
import { extensionOf, siteFileType } from "@/lib/publish/fileset/checks";
import { liveUrl } from "@/lib/publish/pipeline";
import { siteIdSchema } from "@/lib/sites/owner-routes";
import { CHANNEL_LABEL, fileSetSummary, formatBytes, formatTimestamp } from "@/lib/sites/display";

import { Section } from "../../../../(app)/site/[id]/section";
import { ADMIN_METADATA, AdminShell } from "../../admin-shell";
import { AppealDecision, DismissReports, SiteActions } from "./decisions";
import { HiddenPreview, PreviewPanel } from "./preview";

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-sm text-text-secondary">{term}</dt>
      <dd className="min-w-0 break-words text-sm text-text">{children}</dd>
    </>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs uppercase tracking-[0.06em]">{children}</span>;
}

function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-text-muted">none</span>;
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-[var(--r-md)] bg-sunken p-3 font-mono text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** Per-request and cookie-gated: never prerendered. */
export const dynamic = "force-dynamic";

export const metadata = ADMIN_METADATA;

const FACTS = "grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]";

export default async function ModerationItemPage({ params }: { params: Promise<{ id: string }> }) {
  // The gate, before anything is read or drawn (`../../admin-shell.tsx`).
  if (!(await getAdminSession())) notFound();
  const id = siteIdSchema.safeParse((await params).id);
  if (!id.success) notFound();
  const item = await moderationItem(id.data);
  if (!item) notFound();

  const { site, scan, reports, appeals, timeline, files } = item;
  const withheld = withholdsBytes({ moderationReason: site.reason });
  const html = withheld ? null : await readAdminHtml(site);
  const openReportIds = reports.filter((report) => report.status === "open").map((report) => report.id);
  const openAppeal = appeals.find((appeal) => appeal.status === "open") ?? null;

  return (
    <AdminShell>
      <Link href="/admin/moderation" className="font-mono text-xs uppercase tracking-[0.08em] text-text-secondary">
        ‹ Moderation
      </Link>
      <h1 data-testid="item-slug" className="break-all font-display text-[28px] font-bold leading-[1.15] tracking-[-0.03em]">
        {site.slug}
      </h1>

      <Section title="The page" testId="item-facts">
        <dl className={FACTS}>
          <Fact term="Address">
            <span className="font-mono">{liveUrl(site.slug)}</span>
          </Fact>
          <Fact term="Status">
            <span data-testid="item-status">
              <Mono>{site.status}</Mono>
            </span>
            {site.reason ? (
              <>
                {" · "}
                <Mono>{site.reason}</Mono>
              </>
            ) : null}
          </Fact>
          <Fact term="Kind">{site.expiresAt ? `Draft (clock ${formatTimestamp(site.expiresAt)})` : "Kept"}</Fact>
          <Fact term="Owner">{site.owner}</Fact>
          <Fact term="Channel">{site.channel ? `${CHANNEL_LABEL[site.channel]} (${site.channel})` : "no version"}</Fact>
          <Fact term="Created">{formatTimestamp(site.createdAt)}</Fact>
          {site.purgeAfter ? <Fact term="Purge after">{formatTimestamp(site.purgeAfter)}</Fact> : null}
        </dl>
      </Section>

      <Section title="Decide" testId="item-actions">
        <SiteActions
          siteId={site.id}
          allowed={allowedSiteActions(site.status)}
          reason={site.reason}
          graceDays={DRAFT_GRACE_DAYS}
        />
      </Section>

      <Section title="Why it was flagged" testId="item-scan">
        {scan ? (
          <dl className={FACTS}>
            <Fact term="Scan">
              <Mono>
                {scan.trigger} · {scan.status}
                {scan.verdict ? ` · ${scan.verdict}` : ""}
              </Mono>{" "}
              {formatTimestamp(scan.createdAt)}
            </Fact>
            <Fact term="Rule">{scan.rule ?? "none"}</Fact>
            <Fact term="Reason">{scan.reason ?? "none"}</Fact>
            <Fact term="Model">
              {scan.model ?? "none"} · policy {scan.policyVersion}
            </Fact>
            {scan.error ? <Fact term="Error">{scan.error}</Fact> : null}
            <Fact term="Probabilities">
              <Json value={scan.answers} />
            </Fact>
            <Fact term="Facts">
              <Json value={scan.facts} />
            </Fact>
          </dl>
        ) : (
          <p className="text-sm text-text-secondary">No scan of the current version.</p>
        )}
      </Section>

      <Section title="The page itself" testId="item-preview">
        {withheld ? (
          <HiddenPreview siteId={site.id} slug={site.slug} />
        ) : html === null ? (
          <p className="text-sm text-text-secondary">The page&rsquo;s bytes could not be read.</p>
        ) : (
          <PreviewPanel html={html} siteId={site.id} slug={site.slug} />
        )}
        {!withheld && files.length > 1 ? (
          <div data-testid="item-files" className="flex flex-col gap-2">
            <p data-testid="item-files-summary" className="text-sm text-text-secondary">
              {fileSetSummary(
                files.length,
                files.reduce((total, file) => total + file.sizeBytes, 0),
              )}
            </p>
            <ul className="max-h-72 overflow-auto rounded-[var(--r-md)] border border-border bg-sunken p-3 font-mono text-xs">
              {files.map((file) => (
                <li key={file.path} data-testid="item-file" className="grid grid-cols-[1fr_auto_auto] gap-x-4 py-0.5">
                  <span className="min-w-0 break-all text-text">{file.path}</span>
                  <span className="text-right text-text-secondary">{formatBytes(file.sizeBytes)}</span>
                  <span className="text-text-muted">
                    {siteFileType(extensionOf(file.path))?.contentType ?? "application/octet-stream"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      <Section
        title={`Reports (${reports.length})`}
        testId="item-reports"
        status={openReportIds.length > 0 ? <DismissReports reportIds={openReportIds} /> : null}
      >
        {reports.length === 0 ? (
          <p className="text-sm text-text-secondary">No reports.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {reports.map((report) => (
              <li key={report.id} data-testid={`item-report-${report.id}`} data-status={report.status} className="flex flex-col gap-1">
                <span>
                  <Mono>
                    {report.category} · {report.status}
                  </Mono>{" "}
                  <span className="text-xs text-text-muted">{formatTimestamp(report.createdAt)}</span>
                </span>
                <p className="whitespace-pre-wrap text-sm">{report.details}</p>
                {report.resolutionNote ? <p className="text-xs text-text-secondary">Note: {report.resolutionNote}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Appeal"
        testId="item-appeals"
        status={openAppeal ? <AppealDecision appealId={openAppeal.id} /> : null}
      >
        {appeals.length === 0 ? (
          <p className="text-sm text-text-secondary">No appeal.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {appeals.map((appeal) => (
              <li key={appeal.id} data-testid={`item-appeal-${appeal.id}`} data-status={appeal.status} className="flex flex-col gap-1">
                <span>
                  <Mono>
                    {appeal.status} · {appeal.anonymous ? "anonymous" : "owner"}
                  </Mono>{" "}
                  <span className="text-xs text-text-muted">{formatTimestamp(appeal.createdAt)}</span>
                </span>
                <p className="whitespace-pre-wrap text-sm">{appeal.message}</p>
                {appeal.decisionNote ? <p className="text-xs text-text-secondary">Decision: {appeal.decisionNote}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Timeline" testId="item-timeline">
        {timeline.length === 0 ? (
          <p className="text-sm text-text-secondary">No moderation actions yet.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {timeline.map((action) => (
              <li key={action.id} data-testid="timeline-row" data-action={action.action} className="flex flex-col gap-0.5">
                <span>
                  <Mono>
                    {action.actor} · {action.action} · {action.fromStatus}
                    {action.toStatus ? ` → ${action.toStatus}` : ""}
                    {action.reason ? ` · ${action.reason}` : ""}
                  </Mono>{" "}
                  <span className="text-xs text-text-muted">
                    {formatTimestamp(action.createdAt)} · {action.automated ? "automated" : "by a person"}
                  </span>
                </span>
                {action.note ? <p className="text-sm text-text-secondary">{action.note}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </Section>
    </AdminShell>
  );
}
