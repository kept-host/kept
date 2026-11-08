"use client";

/**
 * Settings → Profile (E10 §5.5) — the handle field, from `kept Settings
 * Screen.dc.html`'s Handle section, painted from tokens (Q10: flagged for
 * Arun's review). Task 009 adds the rest of the Profile section here.
 *
 * ── editing → checking → resolved → saving ───────────────────────────────────
 * The field is always open, prefilled with the current handle. A typed name
 * settles, then `GET /api/names/check?handle=1` answers in E06's name-check
 * words (`nameStatusMessage`), `handle_change_limited` with its date among
 * them. Saving sends `PUT /api/profile/handle`, which re-asks everything under
 * its locks — the check is advisory, the save is the authority.
 *
 * A change (there is a current handle) states its consequence inline, as the
 * design does: the old address redirects forever, page addresses don't move,
 * and the next change waits `HANDLE_CHANGE_DAYS`.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { toast } from "sonner";

import { HANDLE_CHANGE_DAYS, type NameCheckStatus } from "@kept/shared";

import { LockedRow } from "@/components/kept/locked-row";
import { Button } from "@/components/ui/button";
import { nameStatusMessage } from "@/lib/names/messages";
import { checkHandleName, saveHandle } from "@/lib/sites/owner-client";
import { cn } from "@/lib/utils";

import { SettingsCard } from "./settings-card";

/** How long a typed handle settles before it is checked — the rename field's pace. */
const SETTLE_MS = 350;

type Phase = "editing" | "checking" | "resolved" | "saving";

type Verdict =
  | { kind: "accepted"; message: string }
  | { kind: "refused"; reason: Exclude<NameCheckStatus, "available" | "held_for_you"> | "refused"; message: string };

export function ProfilePanel({
  handle,
  baseDomain,
  blockedUntil,
}: {
  /** The current handle, or `null` before the first one. */
  handle: string | null;
  /** `servingBaseDomain()` — from configuration, never the request. */
  baseDomain: string;
  /** `YYYY-MM-DD` while a change is still refused (D10), else `null`. */
  blockedUntil: string | null;
}) {
  const router = useRouter();
  const suffix = `.${baseDomain}`;
  const limited = (availableOn: string) =>
    nameStatusMessage({ status: "handle_change_limited", availableOn }, "", suffix);

  const [current, setCurrent] = useState(handle);
  const [value, setValue] = useState(handle ?? "");
  const [phase, setPhase] = useState<Phase>("editing");
  const [verdict, setVerdict] = useState<Verdict | null>(
    blockedUntil ? { kind: "refused", reason: "handle_change_limited", message: limited(blockedUntil) } : null,
  );
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checking = useRef<AbortController | null>(null);
  const saving = useRef<AbortController | null>(null);
  const fieldId = useId();
  const statusId = useId();

  useEffect(() => {
    return () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
      checking.current?.abort();
      saving.current?.abort();
    };
  }, []);

  const candidate = value.trim();
  const unchanged = candidate === (current ?? "");
  const canSubmit = candidate !== "" && !unchanged && verdict?.kind === "accepted" && phase === "resolved";

  function onChange(next: string) {
    setValue(next);
    if (settleTimer.current) clearTimeout(settleTimer.current);
    checking.current?.abort();

    const name = next.trim();
    if (name === "" || name === (current ?? "")) {
      setVerdict(null);
      setPhase("editing");
      return;
    }

    setVerdict(null);
    setPhase("checking");
    settleTimer.current = setTimeout(async () => {
      const controller = new AbortController();
      checking.current = controller;
      const outcome = await checkHandleName(name, controller.signal);
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

  async function save() {
    if (!canSubmit) return;
    setPhase("saving");
    saving.current?.abort();
    const controller = new AbortController();
    saving.current = controller;
    const outcome = await saveHandle(candidate, controller.signal);
    if (controller.signal.aborted) return;

    if (!outcome.ok) {
      setPhase("resolved");
      setVerdict({
        kind: "refused",
        reason: outcome.error.code === "handle_change_limited" ? "handle_change_limited" : "refused",
        message: outcome.error.message,
      });
      return;
    }

    const { handle: saved, nextChangeOn } = outcome.result;
    setCurrent(saved);
    setValue(saved);
    setPhase("editing");
    setVerdict(
      nextChangeOn ? { kind: "refused", reason: "handle_change_limited", message: limited(nextChangeOn) } : null,
    );
    toast.success(`Your handle is now ${saved}${suffix}.`);
    router.refresh();
  }

  return (
    <SettingsCard title="Handle" data-testid="handle-section">
      <p data-testid="handle-current" className="text-[15px] text-text">
        {current ? (
          <>
            Your handle is <span className="font-mono">{current}{suffix}</span>
          </>
        ) : (
          "Pick a handle — one name that is yours, like a page name."
        )}
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="flex flex-col gap-2.5"
      >
        <label htmlFor={fieldId} className="text-sm font-medium text-text">
          {current ? "New handle" : "Handle"}
        </label>
        <div
          className={cn(
            "flex h-11 items-center gap-0.5 rounded-[var(--r-sm)] border bg-surface px-3 font-mono text-sm focus-within:ring-2 focus-within:ring-accent",
            verdict?.kind === "refused" && !unchanged
              ? "border-danger"
              : verdict?.kind === "accepted"
                ? "border-live"
                : "border-border",
          )}
        >
          <input
            id={fieldId}
            name="handle"
            value={value}
            data-testid="handle-input"
            disabled={phase === "saving"}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-describedby={statusId}
            aria-invalid={verdict?.kind === "refused" && !unchanged ? true : undefined}
            onChange={(event) => onChange(event.target.value.toLowerCase())}
            className="h-8 min-w-0 flex-1 bg-transparent text-text outline-none"
          />
          <span className="shrink-0 text-text-secondary">{suffix}</span>
        </div>

        <div
          id={statusId}
          aria-live="polite"
          data-testid="handle-status"
          data-phase={phase}
          data-reason={verdict?.kind === "refused" ? verdict.reason : undefined}
          className={cn(
            "min-h-5 text-[13px] leading-relaxed",
            verdict?.kind === "refused" ? "text-danger" : "text-text-secondary",
          )}
        >
          {phase === "checking" ? (
            "Checking that handle…"
          ) : phase === "saving" ? (
            "Saving your handle…"
          ) : verdict?.kind === "accepted" ? (
            <span className="inline-flex items-center gap-1.5 text-text">
              <Check aria-hidden="true" className="size-3.5 text-live" strokeWidth={2} />
              {verdict.message}
            </span>
          ) : verdict?.kind === "refused" && verdict.reason === "pro_length" ? (
            <LockedRow className="py-1 text-text">{verdict.message}</LockedRow>
          ) : verdict?.kind === "refused" ? (
            verdict.message
          ) : unchanged && current ? (
            "This is your current handle."
          ) : null}
        </div>

        {current && !unchanged && verdict?.kind === "accepted" ? (
          <p
            data-testid="handle-warning"
            className="rounded-[var(--r-md)] border border-[color-mix(in_srgb,var(--warning)_40%,var(--border))] bg-[color-mix(in_srgb,var(--warning)_14%,var(--surface))] px-3.5 py-3 text-sm leading-relaxed text-text"
          >
            <span className="font-mono">{current}{suffix}</span> will redirect to the new address forever,
            so old links keep working. Your page addresses don&apos;t change. You can change your handle
            once every {HANDLE_CHANGE_DAYS} days.
          </p>
        ) : null}

        <Button
          type="submit"
          size="sm"
          data-testid="handle-save"
          disabled={!canSubmit}
          className="self-start font-body font-medium"
        >
          {current ? "Rename handle" : "Set handle"}
        </Button>
      </form>
    </SettingsCard>
  );
}
