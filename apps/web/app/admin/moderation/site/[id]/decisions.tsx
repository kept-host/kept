"use client";

/**
 * The item view's actions (E07 §6.11, AC21): Restore · Hide · Remove on the
 * page, Dismiss on its open reports, Grant / Reject on its open appeal. Each
 * opens one dialog that asks for the reason (`lib/moderation/admin-rules.ts`
 * says which kind) and an optional note; Remove also asks for an explicit
 * confirmation. Nothing is written before the dialog's confirm button, and the
 * server re-validates every body — the browser only shapes it.
 */
import { MODERATION_REASONS, type ModerationReason } from "@kept/shared";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ADMIN_NOTE_MAX } from "@/lib/moderation/admin-rules";

import { ConfirmDialog } from "../../../../(app)/site/[id]/confirm-dialog";

interface Decision {
  /** Button label and dialog title. */
  label: string;
  testId: string;
  url: string;
  /** The JSON body, given the dialog's fields. */
  body: (fields: { reason: ModerationReason | null; note: string }) => Record<string, unknown>;
  /** A restriction takes a listed reason; every other decision a written one. */
  kind: "restriction" | "written";
  description: string;
  destructive?: boolean;
  /** Remove: an extra "I understand" before the confirm button unlocks. */
  confirmation?: string;
}

const FIELD = "flex flex-col gap-1.5";
const SELECT =
  "h-10 rounded-[var(--r-md)] border border-border bg-surface px-3 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

function DecisionButton({ decision, initialReason }: { decision: Decision; initialReason: ModerationReason | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ModerationReason | null>(initialReason);
  const [note, setNote] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready =
    (decision.kind === "restriction" ? reason !== null : note.trim().length > 0) &&
    (!decision.confirmation || understood);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(decision.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(decision.body({ reason, note })),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? `That didn't work (HTTP ${response.status}).`);
        return;
      }
      setOpen(false);
      setNote("");
      setUnderstood(false);
      router.refresh();
    } catch {
      setError("That didn't reach the server. Nothing was changed; try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant={decision.destructive ? "destructive" : "secondary"}
        data-testid={decision.testId}
        onClick={() => setOpen(true)}
        className="font-body font-medium"
      >
        {decision.label}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={decision.label}
        description={decision.description}
        confirmLabel={decision.label}
        confirmVariant={decision.destructive ? "destructive" : "primary"}
        confirmDisabled={!ready}
        testId={`${decision.testId}-dialog`}
        pending={pending}
        error={error}
        onConfirm={confirm}
      >
        {decision.kind === "restriction" ? (
          <div className={FIELD}>
            <Label htmlFor={`${decision.testId}-reason`}>Reason</Label>
            <select
              id={`${decision.testId}-reason`}
              data-testid={`${decision.testId}-reason`}
              className={SELECT}
              value={reason ?? ""}
              onChange={(event) => setReason((event.target.value || null) as ModerationReason | null)}
            >
              <option value="">Choose a reason</option>
              {MODERATION_REASONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className={FIELD}>
          <Label htmlFor={`${decision.testId}-note`}>
            {decision.kind === "written" ? "Reason (sent to the people affected)" : "Note (optional, sent to the owner)"}
          </Label>
          <Textarea
            id={`${decision.testId}-note`}
            data-testid={`${decision.testId}-note`}
            maxLength={ADMIN_NOTE_MAX}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        {decision.confirmation ? (
          <label className="flex items-start gap-2 text-sm text-text">
            <input
              type="checkbox"
              data-testid={`${decision.testId}-understood`}
              checked={understood}
              onChange={(event) => setUnderstood(event.target.checked)}
              className="mt-0.5 accent-[var(--danger)]"
            />
            {decision.confirmation}
          </label>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

const siteUrl = (siteId: string) => `/api/admin/moderation/sites/${siteId}`;

/** Restore / Hide / Remove — only the edges the transition table allows from the page's status. */
export function SiteActions({
  siteId,
  allowed,
  reason,
  graceDays,
}: {
  siteId: string;
  allowed: { restore: boolean; hide: boolean; remove: boolean };
  /** The page's current reason, preselected for Hide and Remove. */
  reason: ModerationReason | null;
  graceDays: number;
}) {
  const decisions: Decision[] = [];
  if (allowed.restore) {
    decisions.push({
      label: "Restore",
      testId: "action-restore",
      url: siteUrl(siteId),
      kind: "written",
      body: ({ note }) => ({ action: "restore", note }),
      description: "The page goes live again and the owner is told why. An open appeal is granted with it.",
    });
  }
  if (allowed.hide) {
    decisions.push({
      label: "Hide",
      testId: "action-hide",
      url: siteUrl(siteId),
      kind: "restriction",
      body: ({ reason: chosen, note }) => ({ action: "hide", reason: chosen, note }),
      description: "The page stops serving (quarantined). The owner gets a statement of reasons; open reports are closed as actioned.",
    });
  }
  if (allowed.remove) {
    decisions.push({
      label: "Remove",
      testId: "action-remove",
      url: siteUrl(siteId),
      kind: "restriction",
      destructive: true,
      body: ({ reason: chosen, note }) => ({ action: "remove", reason: chosen, note }),
      description: `The page is removed and its name held. It is purged in ${graceDays} days unless restored. Open reports are closed as actioned.`,
      confirmation: `I've checked this page and want it removed (purged in ${graceDays} days).`,
    });
  }
  if (decisions.length === 0) return <p className="text-sm text-text-secondary">No status change is open from here.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {decisions.map((decision) => (
        <DecisionButton key={decision.testId} decision={decision} initialReason={reason} />
      ))}
    </div>
  );
}

/** Dismiss every open report on the page, with one written reason. */
export function DismissReports({ reportIds }: { reportIds: string[] }) {
  return (
    <DecisionButton
      initialReason={null}
      decision={{
        label: `Dismiss ${reportIds.length === 1 ? "report" : `${reportIds.length} reports`}`,
        testId: "action-dismiss",
        url: "/api/admin/moderation/reports",
        kind: "written",
        body: ({ note }) => ({ reportIds, note }),
        description: "The open reports are closed as dismissed. Reporters who left an address get the decision with your reason.",
      }}
    />
  );
}

/** Grant (restore the page) or reject the open appeal. */
export function AppealDecision({ appealId }: { appealId: string }) {
  const url = `/api/admin/moderation/appeals/${appealId}`;
  return (
    <div className="flex flex-wrap gap-2">
      <DecisionButton
        initialReason={null}
        decision={{
          label: "Grant appeal",
          testId: "action-grant",
          url,
          kind: "written",
          body: ({ note }) => ({ decision: "grant", note }),
          description: "The page is restored and the owner is told.",
        }}
      />
      <DecisionButton
        initialReason={null}
        decision={{
          label: "Reject appeal",
          testId: "action-reject",
          url,
          kind: "written",
          body: ({ note }) => ({ decision: "reject", note }),
          description: "The page stays as it is. The owner gets your reason.",
        }}
      />
    </div>
  );
}
