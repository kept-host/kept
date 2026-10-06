"use client";

/**
 * The Versions tab — PRD §5.5, §9.2, AC25 (UI). E06 task 012.
 *
 * `listVersions` (task 007), newest first by `activated_at`: when the file was
 * published, its size and its door (Web / Studio / API), the served one marked
 * CURRENT. A page with one version says so in the PRD's words.
 *
 *   · **Replace** — `DropTarget`'s zone (drop or choose), then task 011's shared
 *     replace toast: "No changes — …" for the bytes already served, otherwise
 *     "Replaced. Same link, new version." with **Undo** (a restore of the
 *     version that was current) and, once per session on Free when a version
 *     was pruned, the version-limit note.
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
import { toastReplaced } from "@/components/kept/replace-toast";
import { Button } from "@/components/ui/button";
import type { VersionListItem } from "@/lib/db/queries/versions";
import {
  CHANNEL_LABEL,
  FIRST_VERSION_NOTE,
  formatBytes,
  formatTimestamp,
  PRO_VERSIONS_LINE,
  restoredToast,
  restoreWarning,
} from "@/lib/sites/display";
import { replacePage, restoreVersion } from "@/lib/sites/owner-client";

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
  const [replacing, setReplacing] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<VersionListItem | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const refresh = () => router.refresh();

  async function replace(file: File) {
    setReplacing(true);
    let html: string;
    try {
      html = await file.text();
    } catch {
      setReplacing(false);
      toast.error("That file could not be read. Try choosing it again.", { description: host });
      return;
    }
    const outcome = await replacePage(siteId, html);
    setReplacing(false);
    if (!outcome.ok) {
      toast.error(outcome.error.message, { description: host });
      return;
    }
    toastReplaced({ page: outcome.page, host, plan, refresh });
  }

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
              <span className="font-mono text-xs text-text-secondary">
                {formatBytes(version.sizeBytes)} · {CHANNEL_LABEL[version.publishedVia]}
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
        <div className="flex flex-col gap-1.5 pt-2" aria-busy={replacing || undefined}>
          <DropTarget
            scope="zone"
            disabled={replacing}
            onFile={replace}
            onRefuse={(message) => toast.error(message, { description: host })}
            className="min-h-28"
          />
          {replacing ? (
            <p role="status" className="text-[13px] text-text-secondary">
              Uploading…
            </p>
          ) : null}
        </div>
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
