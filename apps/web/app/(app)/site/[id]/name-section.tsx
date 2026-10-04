"use client";

/**
 * General → Name and link — PRD §5.2 item 3 and §5.4, AC17 (UI). E06 task 012:
 * the `[slug]` screen's rename field (task 006 rewired it to the names module),
 * moved here and restyled as the design's "Address" card.
 *
 * ── idle → editing → checking → resolved → (dialog) → saving ─────────────────
 * **idle** shows the link in mono and **Change name**. **checking** is the
 * debounce plus `GET /api/names/check` — a real state, not a flicker. A
 * **resolved** verdict is one of PRD §5.4's statuses in `nameStatusMessage`'s
 * words: `available` with the `--live` tick, `pro_length` as the locked row.
 * Saving opens the warning first — the old link stops working, and a chosen
 * name is held — and only its confirm sends the PATCH.
 *
 * ── THE CHECK IS ADVISORY ────────────────────────────────────────────────────
 * The rename re-asks everything under its locks. A refused verdict holds the
 * button shut (there is no point warning about a rename the server has already
 * said no to), but an accepted one is not permission: a name taken between the
 * check and the save comes back `409 name_taken`, and the field says "That name
 * is taken." with nothing changed.
 *
 * The route is keyed by id (D2), so a rename moves nothing under this screen:
 * the toast, then `router.refresh()` repaints the link. (The `[slug]` screen had
 * to navigate, and carried its notice across the remount in the URL.)
 *
 * Drafts get the helper instead of the button (AC17); a page under review gets
 * neither — the banner says why.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { toast } from "sonner";

import type { NameCheckStatus } from "@kept/shared";

import { LockedRow } from "@/components/kept/locked-row";
import { Button } from "@/components/ui/button";
import { DRAFT_NAME_NOTE, nameStatusMessage, namesUsed, renameWarning } from "@/lib/names/messages";
import { checkName, renameNotice, renamePage } from "@/lib/sites/owner-client";
import { cn } from "@/lib/utils";

import { ConfirmDialog } from "./confirm-dialog";
import { Section } from "./section";

/** How long a typed name settles before it is checked — long enough not to strobe mid-word. */
const SETTLE_MS = 350;

type Phase = "idle" | "editing" | "checking" | "resolved" | "confirming" | "saving";

/** Why a resolved name was refused: its check status, or `refused` for any other answer. */
type RefusalKind = Exclude<NameCheckStatus, "available" | "held_for_you"> | "refused";

type Verdict =
  | { kind: "accepted"; message: string }
  | { kind: "refused"; reason: RefusalKind; message: string };

export function NameSection({
  siteId,
  slug,
  baseDomain,
  nameChosen,
  canRename,
  isDraft,
  names,
  nameQuota,
}: {
  siteId: string;
  slug: string;
  /** `servingBaseDomain()` — from configuration, never the request. */
  baseDomain: string;
  /** The current name was chosen (D3) — so renaming away holds it (D4). */
  nameChosen: boolean;
  /** Kept and `live` (PRD §5.2). */
  canRename: boolean;
  /** A draft: the helper replaces the button (AC17). */
  isDraft: boolean;
  /** Chosen names in use, and the plan's quota. */
  names: number;
  nameQuota: number;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [value, setValue] = useState(slug);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checking = useRef<AbortController | null>(null);
  const saving = useRef<AbortController | null>(null);
  const fieldId = useId();
  const statusId = useId();
  const suffix = `.${baseDomain}`;

  useEffect(() => {
    return () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
      checking.current?.abort();
      saving.current?.abort();
    };
  }, []);

  const editing = phase !== "idle";
  const candidate = value.trim();
  const unchanged = candidate === slug;
  const canSubmit =
    candidate !== "" && !unchanged && verdict?.kind !== "refused" && phase !== "saving";

  function startEditing() {
    setVerdict(null);
    setValue(slug);
    setPhase("editing");
    requestAnimationFrame(() => inputRef.current?.select());
  }

  function cancel() {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    checking.current?.abort();
    setPhase("idle");
    setValue(slug);
    setVerdict(null);
  }

  function onChange(next: string) {
    setValue(next);
    setVerdict(null);
    if (settleTimer.current) clearTimeout(settleTimer.current);
    checking.current?.abort();

    const name = next.trim();
    if (name === "" || name === slug) {
      setPhase("editing");
      return;
    }

    setPhase("checking");
    settleTimer.current = setTimeout(async () => {
      const controller = new AbortController();
      checking.current = controller;
      const outcome = await checkName(siteId, name, controller.signal);
      if (controller.signal.aborted) return;

      if (!outcome.ok) {
        setVerdict({ kind: "refused", reason: "refused", message: outcome.error.message });
      } else {
        const { result } = outcome;
        const message = nameStatusMessage(result, name, suffix);
        setVerdict(
          result.status === "available" || result.status === "held_for_you"
            ? { kind: "accepted", message }
            : { kind: "refused", reason: result.status, message },
        );
      }
      setPhase("resolved");
    }, SETTLE_MS);
  }

  async function rename() {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    checking.current?.abort();
    setPhase("saving");

    saving.current?.abort();
    const controller = new AbortController();
    saving.current = controller;
    const outcome = await renamePage(siteId, candidate, controller.signal);
    if (controller.signal.aborted) return;

    if (!outcome.ok) {
      // Nothing changed — the field keeps what was typed so it can be fixed,
      // and says the handler's own sentence ("That name is taken." on a race).
      setPhase("resolved");
      setVerdict({
        kind: "refused",
        reason: outcome.error.code === "name_taken" ? "taken" : "refused",
        message: outcome.error.message,
      });
      return;
    }

    setPhase("idle");
    setVerdict(null);
    toast.success(renameNotice(outcome.site));
    router.refresh();
  }

  return (
    <Section title="Name and link" testId="name-section">
      {!editing ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p data-testid="current-link" className="min-w-0 font-mono text-sm break-all text-text">
            {slug}
            <span className="text-text-secondary">{suffix}</span>
          </p>
          {canRename ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="rename-start"
              onClick={startEditing}
              className="font-body font-medium"
            >
              Change name
            </Button>
          ) : null}
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) setPhase("confirming");
          }}
          className="flex flex-col gap-2.5"
        >
          <label htmlFor={fieldId} className="text-sm font-medium text-text">
            New name
          </label>
          <div
            className={cn(
              "flex h-11 items-center gap-0.5 rounded-[var(--r-sm)] border bg-surface px-3 font-mono text-sm focus-within:ring-2 focus-within:ring-accent",
              verdict?.kind === "refused"
                ? "border-danger"
                : verdict?.kind === "accepted"
                  ? "border-live"
                  : "border-border",
            )}
          >
            <input
              ref={inputRef}
              id={fieldId}
              name="name"
              value={value}
              data-testid="rename-input"
              disabled={phase === "saving"}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-describedby={statusId}
              aria-invalid={verdict?.kind === "refused" ? true : undefined}
              onChange={(event) => onChange(event.target.value.toLowerCase())}
              onKeyDown={(event) => {
                if (event.key === "Escape") cancel();
              }}
              className="h-8 min-w-0 flex-1 bg-transparent text-text outline-none"
            />
            <span className="shrink-0 text-text-secondary">{suffix}</span>
          </div>

          <div
            id={statusId}
            aria-live="polite"
            data-testid="rename-status"
            data-phase={phase}
            data-reason={verdict?.kind === "refused" ? verdict.reason : undefined}
            className={cn(
              "min-h-5 text-[13px] leading-relaxed",
              verdict?.kind === "refused" ? "text-danger" : "text-text-secondary",
            )}
          >
            {phase === "checking" ? (
              "Checking that name…"
            ) : phase === "saving" ? (
              "Changing the name…"
            ) : verdict?.kind === "accepted" ? (
              <span className="inline-flex items-center gap-1.5 text-text">
                <Check aria-hidden="true" className="size-3.5 text-live" strokeWidth={2} />
                {verdict.message}
              </span>
            ) : verdict?.kind === "refused" && verdict.reason === "pro_length" ? (
              <LockedRow className="py-1 text-text">{verdict.message}</LockedRow>
            ) : verdict?.kind === "refused" ? (
              verdict.message
            ) : unchanged ? (
              "This is the page's current name."
            ) : null}
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={phase === "saving"}
              onClick={cancel}
              className="font-body font-medium"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              data-testid="rename-save"
              disabled={!canSubmit}
              className="font-body font-medium"
            >
              Change name
            </Button>
          </div>
        </form>
      )}

      {isDraft ? (
        <p data-testid="draft-name-note" className="text-sm text-text-secondary">
          {DRAFT_NAME_NOTE}
        </p>
      ) : null}

      <p className="font-mono text-xs font-medium uppercase tracking-[0.08em] text-text-secondary">
        {namesUsed(names, nameQuota)}
      </p>

      <ConfirmDialog
        open={phase === "confirming" || phase === "saving"}
        onOpenChange={(open) => {
          if (!open) setPhase("resolved");
        }}
        title={`Change the name to ${candidate}?`}
        description={renameWarning(`${slug}${suffix}`, nameChosen)}
        confirmLabel={phase === "saving" ? "Changing…" : "Change name"}
        testId="rename-dialog"
        pending={phase === "saving"}
        onConfirm={rename}
      />
    </Section>
  );
}
