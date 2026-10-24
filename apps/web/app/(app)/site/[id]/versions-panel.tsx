"use client";

/**
 * The Versions tab — PRD §5.5, §9.2, AC25 (UI). E06 task 012.
 *
 * `listVersions` (task 007), newest first by `activated_at`: when the file was
 * published, "{n} files · {size}" (E08 §5.7) and its door (Web / Studio / API),
 * the served one marked CURRENT. A page with one version says so in the PRD's
 * words.
 *
 *   · **Replace** — `DropTarget`'s zone (a page, files, a folder or a `.zip`),
 *     with "Serve as a single-page app" starting from the current version's
 *     value (E08 D12), then task 011's shared replace toast: "No changes — …"
 *     for the bytes already served, otherwise "Replaced. Same link, new
 *     version." with **Undo** (a restore of the version that was current) and,
 *     once per session on Free when a version was pruned, the version-limit
 *     note. A set over Free's size cap adds the locked row (E06 D15).
 *   · **Restore** — confirm → restoring → done, a pointer move with no upload.
 *
 * Both only while the page is `live` (PRD §5.2) — otherwise they are absent,
 * and the list is a record. Free accounts see the locked row with Pro's count.
 *
 * Not rendered: the design's version labels (V4…V1 — no stable number exists
 * once pruning drops the oldest) and its old-version preview (not in the PRD).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import type { Plan } from "@kept/shared";

import { DropTarget } from "@/components/kept/drop-target";
import { LockedRow } from "@/components/kept/locked-row";
import { SpaCheckbox } from "@/components/kept/spa-checkbox";
import { UploadProgressBar } from "@/components/kept/upload-progress";
import { useReplace } from "@/components/kept/use-replace";
import { Button } from "@/components/ui/button";
import type { VersionListItem } from "@/lib/db/queries/versions";
import {
  CHANNEL_LABEL,
  fileSetSummary,
  FIRST_VERSION_NOTE,
  formatTimestamp,
  PRO_SITE_BYTES_LINE,
  PRO_VERSIONS_LINE,
  restoredToast,
  restoreWarning,
} from "@/lib/sites/display";
import { restoreVersion } from "@/lib/sites/owner-client";
import { progressNotice } from "@/lib/sites/owner-upload";

import { ConfirmDialog } from "./confirm-dialog";
import { Section } from "./section";

export function VersionsPanel({
  siteId,
  host,
  plan,
  versions,
  canChange,
}: {
  siteId: string;
  host: string;
  plan: Plan;
  versions: VersionListItem[];
  /** `live`: replace and restore are offered. Otherwise absent (PRD §5.2). */
  canChange: boolean;
}) {
  const router = useRouter();
  const [restoreTarget, setRestoreTarget] = useState<VersionListItem | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const refresh = () => router.refresh();
  const current = versions.find((version) => version.isCurrent);

  async function restore() {
    if (!restoreTarget) return;
    setRestoring(true);
    setRestoreError(null);
    const outcome = await restoreVersion(siteId, restoreTarget.id);
    setRestoring(false);
    if (!outcome.ok) {
      setRestoreError(outcome.error.message);
      return;
    }
    setRestoreTarget(null);
    toast.success(restoredToast(formatTimestamp(restoreTarget.createdAt)), { description: host });
    refresh();
  }

  return (
    <Section title="Versions" testId="versions-panel" className="gap-2">
      <ul data-testid="versions-list" className="flex flex-col">
        {versions.map((version) => (
          <li
            key={version.id}
            data-testid="version-row"
            data-version-id={version.id}
            data-current={version.isCurrent ? "true" : undefined}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border py-2.5"
          >
            <span className="flex min-w-[140px] flex-1 flex-col leading-[1.35]">
              <span className="text-sm text-text">{formatTimestamp(version.createdAt)}</span>
              <span data-testid="version-files" className="font-mono text-xs text-text-secondary">
                {fileSetSummary(version.fileCount, version.sizeBytes)} · {CHANNEL_LABEL[version.publishedVia]}
              </span>
            </span>
            {version.isCurrent ? (
              <span className="inline-flex h-6 items-center gap-1.5 rounded-[var(--r-pill)] bg-sunken px-2.5 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-text">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-live" />
                Current
              </span>
            ) : canChange ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="restore-button"
                onClick={() => {
                  setRestoreError(null);
                  setRestoreTarget(version);
                }}
                className="h-8 rounded-[var(--r-sm)] px-3 font-body text-[13px] font-medium"
              >
                Restore
              </Button>
            ) : null}
          </li>
        ))}
      </ul>

      {versions.length === 1 ? (
        <p data-testid="first-version-note" className="text-sm text-text-secondary">
          {FIRST_VERSION_NOTE}
        </p>
      ) : null}

      {canChange ? (
        // Keyed by the served version, so the checkbox starts again from ITS
        // value after a replace, a restore or an Undo (AC37).
        <ReplaceForm
          key={current?.id ?? "none"}
          siteId={siteId}
          host={host}
          plan={plan}
          initialSpa={current?.spa ?? false}
          refresh={refresh}
        />
      ) : null}

      {plan === "free" ? <LockedRow className="border-t border-border">{PRO_VERSIONS_LINE}</LockedRow> : null}

      <ConfirmDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRestoreTarget(null);
        }}
        title="Restore this version?"
        description={restoreTarget ? restoreWarning(formatTimestamp(restoreTarget.createdAt)) : ""}
        confirmLabel={restoring ? "Restoring…" : "Restore"}
        testId="restore-dialog"
        pending={restoring}
        error={restoreError}
        onConfirm={restore}
      />
    </Section>
  );
}

/** The replace zone, its single-page-app checkbox and what the upload is doing. */
function ReplaceForm({
  siteId,
  host,
  plan,
  initialSpa,
  refresh,
}: {
  siteId: string;
  host: string;
  plan: Plan;
  initialSpa: boolean;
  refresh: () => void;
}) {
  const [spa, setSpa] = useState(initialSpa);
  const [locked, setLocked] = useState(false);
  const { replacing, progress, replace } = useReplace({
    siteId,
    host,
    plan,
    refresh,
    onRefuse: (refusal) => {
      toast.error(refusal.error.message, { description: host });
      setLocked(refusal.locked);
    },
  });

  return (
    <div className="flex flex-col gap-1.5 pt-2" aria-busy={replacing || undefined}>
      <DropTarget
        scope="zone"
        disabled={replacing}
        onUpload={(intent) => {
          setLocked(false);
          void replace(intent, spa);
        }}
        onRefuse={(message) => toast.error(message, { description: host })}
        className="min-h-28"
      />
      <SpaCheckbox checked={spa} onChange={setSpa} disabled={replacing} />
      {replacing ? (
        <div role="status" className="flex flex-col gap-1.5">
          <p className="text-[13px] text-text-secondary">{progress ? progressNotice(progress) : "Uploading…"}</p>
          {progress ? <UploadProgressBar progress={progress} /> : null}
        </div>
      ) : null}
      {locked ? <LockedRow>{PRO_SITE_BYTES_LINE}</LockedRow> : null}
    </div>
  );
}
