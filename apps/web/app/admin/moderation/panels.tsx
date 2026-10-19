/**
 * One server component per moderation tab (E07 §6.11, §9). Each reads only its
 * own data (`lib/db/queries/moderation-screen.ts`); the page wraps it in a
 * Suspense boundary with skeleton rows, and `./error.tsx` catches a failed read.
 *
 * Every string here that came from a stranger — a slug, a report's words, an
 * appeal — is rendered as React text, never as markup.
 */
import { SCANNER_SPEND_WINDOW_DAYS } from "@kept/shared";
import Link from "next/link";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import {
  actionLog,
  LOG_PAGE_SIZE,
  openAppeals,
  openReports,
  queueItems,
  scanSpendUsd,
  spikeScans,
} from "@/lib/db/queries/moderation-screen";
import { jobRun, recentScanFailures } from "@/lib/db/queries/scans";
import { scannerLight } from "@/lib/moderation/admin-rules";
import { scannerEnabled } from "@/lib/scan/classifier";
import { SCAN_RETRY_JOB } from "@/lib/scan/run";
import { formatTimestamp } from "@/lib/sites/display";
import { cn } from "@/lib/utils";

import type { ModerationTab } from "./tab-list";

/** Watch: spike re-scans of the last two weeks. */
const WATCH_DAYS = 14;

export function itemHref(siteId: string): string {
  return `/admin/moderation/site/${siteId}`;
}

/** Status and reason names, as the database spells them — this screen is for one reader. */
function Code({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs uppercase tracking-[0.06em] text-text-secondary">{children}</span>;
}

function Empty() {
  return (
    <p data-testid="moderation-empty" className="rounded-[var(--r-lg)] border border-border bg-surface px-6 py-10 text-center text-[15px] text-text-secondary">
      Nothing to review.
    </p>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <ul className="flex flex-col divide-y divide-border rounded-[var(--r-lg)] border border-border bg-surface">{children}</ul>;
}

function Row({ href, testId, children }: { href: string | null; testId: string; children: ReactNode }) {
  const body = <div className="flex flex-col gap-1.5 px-4 py-3">{children}</div>;
  return (
    <li data-testid={testId}>
      {href ? (
        <Link href={href} className="block outline-none hover:bg-sunken focus-visible:bg-sunken">
          {body}
        </Link>
      ) : (
        body
      )}
    </li>
  );
}

function Line({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{children}</div>;
}

function Slug({ slug }: { slug: string }) {
  return <span className="font-mono text-sm font-medium text-text">{slug}</span>;
}

/** Whose page it is (`owner` in the queries). An address keeps its case and truncates rather than widen the row. */
function Owner({ owner }: { owner: string | null }) {
  return owner ? (
    <span data-testid="row-owner" title={owner} className="min-w-0 max-w-full truncate font-mono text-xs text-text-secondary">
      {owner}
    </span>
  ) : null;
}

function When({ at }: { at: Date | null }) {
  return at ? <span className="text-xs text-text-muted">{formatTimestamp(at)}</span> : null;
}

async function QueuePanel() {
  const items = await queueItems();
  if (items.length === 0) return <Empty />;
  return (
    <Rows>
      {items.map((item) => (
        <Row key={item.id} href={itemHref(item.id)} testId={`queue-${item.id}`}>
          <Line>
            {item.reason === "child_sexual_abuse" ? <Badge variant="danger">Priority</Badge> : null}
            <Slug slug={item.slug} />
            <Code>{item.status}</Code>
            <Code>{item.reason ?? "no reason"}</Code>
            <Code>{item.draft ? "draft" : "kept"}</Code>
            <Owner owner={item.owner} />
          </Line>
          <Line>
            <When at={item.flaggedAt} />
            {item.openReports > 0 ? <Badge variant="warning">{item.openReports} open reports</Badge> : null}
            {item.openAppeal ? <Badge variant="outline">Appeal open</Badge> : null}
          </Line>
        </Row>
      ))}
    </Rows>
  );
}

async function ReportsPanel() {
  const reports = await openReports();
  if (reports.length === 0) return <Empty />;
  return (
    <Rows>
      {reports.map((report) => (
        <Row key={report.id} href={report.siteId ? itemHref(report.siteId) : null} testId={`report-${report.id}`}>
          <Line>
            <Slug slug={report.slug} />
            <Code>{report.category}</Code>
            <Code>{report.siteStatus ?? "purged"}</Code>
            <Owner owner={report.owner} />
            <When at={report.createdAt} />
          </Line>
          <p className="line-clamp-2 text-sm text-text-secondary">{report.details}</p>
        </Row>
      ))}
    </Rows>
  );
}

async function AppealsPanel() {
  const appeals = await openAppeals();
  if (appeals.length === 0) return <Empty />;
  return (
    <Rows>
      {appeals.map((appeal) => (
        <Row key={appeal.id} href={itemHref(appeal.siteId)} testId={`appeal-${appeal.id}`}>
          <Line>
            <Slug slug={appeal.slug} />
            <Code>{appeal.siteStatus}</Code>
            <Code>{appeal.reason ?? "no reason"}</Code>
            <Code>{appeal.anonymous ? "anonymous" : "owner"}</Code>
            <Owner owner={appeal.owner} />
            <When at={appeal.createdAt} />
          </Line>
          <p className="line-clamp-2 text-sm text-text-secondary">{appeal.message}</p>
        </Row>
      ))}
    </Rows>
  );
}

async function WatchPanel() {
  const scans = await spikeScans(WATCH_DAYS);
  if (scans.length === 0) return <Empty />;
  return (
    <Rows>
      {scans.map((scan) => (
        <Row key={scan.id} href={itemHref(scan.siteId)} testId={`watch-${scan.id}`}>
          <Line>
            <Slug slug={scan.slug} />
            <Code>{scan.siteStatus}</Code>
            <Code>
              scan {scan.status}
              {scan.verdict ? ` · ${scan.verdict}` : ""}
              {scan.reason ? ` · ${scan.reason}` : ""}
            </Code>
            <Owner owner={scan.owner} />
            <When at={scan.createdAt} />
          </Line>
        </Row>
      ))}
    </Rows>
  );
}

async function LogPanel({ page }: { page: number }) {
  const { rows, hasMore } = await actionLog(page);
  if (rows.length === 0 && page === 1) return <Empty />;
  return (
    <div className="flex flex-col gap-4">
      <Rows>
        {rows.map((row) => (
          <Row key={row.id} href={row.siteId ? itemHref(row.siteId) : null} testId={`log-${row.id}`}>
            <Line>
              <Slug slug={row.slug} />
              <Code>
                {row.actor} · {row.action}
              </Code>
              <Code>
                {row.fromStatus}
                {row.toStatus ? ` → ${row.toStatus}` : ""}
              </Code>
              {row.reason ? <Code>{row.reason}</Code> : null}
              <Code>{row.automated ? "automated" : "by a person"}</Code>
              <When at={row.createdAt} />
            </Line>
            {row.note ? <p className="text-sm text-text-secondary">{row.note}</p> : null}
          </Row>
        ))}
      </Rows>
      <nav aria-label="Log pages" className="flex items-center gap-4 text-sm">
        {page > 1 ? <Link href={`/admin/moderation?tab=log&page=${page - 1}`}>Newer</Link> : null}
        <span className="text-text-muted">
          Page {page} · {LOG_PAGE_SIZE} per page
        </span>
        {hasMore ? <Link href={`/admin/moderation?tab=log&page=${page + 1}`}>Older</Link> : null}
      </nav>
    </div>
  );
}

const LIGHT_CLASS = { green: "bg-live", amber: "bg-warning", red: "bg-danger" } as const;

async function ScannerPanel() {
  const [job, failures, spend] = await Promise.all([
    jobRun(SCAN_RETRY_JOB),
    recentScanFailures(),
    scanSpendUsd(SCANNER_SPEND_WINDOW_DAYS),
  ]);
  const keyPresent = scannerEnabled();
  const light = scannerLight({ keyPresent, lastSuccessAt: job?.lastSuccessAt ?? null, now: new Date() });
  const lastError = job?.lastError ?? failures.lastError;

  return (
    <dl
      data-testid="scanner-panel"
      data-light={light}
      className="grid gap-x-6 gap-y-3 rounded-[var(--r-lg)] border border-border bg-surface p-5 sm:grid-cols-[max-content_1fr]"
    >
      <dt className="text-sm text-text-secondary">State</dt>
      <dd className="flex items-center gap-2 font-mono text-sm uppercase">
        <span aria-hidden="true" className={cn("size-2.5 rounded-full", LIGHT_CLASS[light])} />
        {light}
        {keyPresent ? "" : " · classifier key missing (scanner off)"}
      </dd>
      <dt className="text-sm text-text-secondary">Last success</dt>
      <dd className="text-sm">{job?.lastSuccessAt ? formatTimestamp(job.lastSuccessAt) : "never"}</dd>
      <dt className="text-sm text-text-secondary">Failures, 24 h</dt>
      <dd className="text-sm">{failures.failures}</dd>
      <dt className="text-sm text-text-secondary">Spend, {SCANNER_SPEND_WINDOW_DAYS} days</dt>
      <dd className="font-mono text-sm">${spend.toFixed(4)}</dd>
      {light === "red" && lastError ? (
        <>
          <dt className="text-sm text-text-secondary">Last error</dt>
          <dd className="break-words font-mono text-xs text-danger">{lastError}</dd>
        </>
      ) : null}
    </dl>
  );
}

export function TabPanel({ tab, page }: { tab: ModerationTab; page: number }) {
  switch (tab) {
    case "queue":
      return <QueuePanel />;
    case "reports":
      return <ReportsPanel />;
    case "appeals":
      return <AppealsPanel />;
    case "watch":
      return <WatchPanel />;
    case "log":
      return <LogPanel page={page} />;
    case "scanner":
      return <ScannerPanel />;
  }
}
