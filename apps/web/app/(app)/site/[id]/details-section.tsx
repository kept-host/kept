"use client";

/**
 * General → Details: the page's title and "List on Explore when it opens" —
 * PRD §5.2 item 2, D11 / D12, AC36 / AC37. E06 task 012.
 *
 * The design's Explore card (`kept Page Screen.dc.html`, `s-explore`) plus the
 * PRD's title field, under one explicit save bar: "Unsaved changes · Discard ·
 * Save" → "Saved." (PRD §15 — not the design's "Showing on your page in about
 * 2 minutes": neither field changes what visitors see in E06).
 *
 * ── STATES ───────────────────────────────────────────────────────────────────
 * clean · dirty (the bar) · saving · saved ("Saved.", then clean) · field error
 * (the route's own sentence, e.g. the title cap) · "Couldn't save. Try again."
 * for anything that is not the studio envelope, the origin 403 included
 * (`COULD_NOT_SAVE`).
 *
 * Only what changed is sent. Clearing the title hands it back to the page's
 * own `<title>`, so the field repaints from the RESPONSE, not from what was
 * typed. A server render that brings new values (a replace re-titled the
 * page) is adopted while the form is clean, never over an edit in progress.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { PAGE_TITLE_MAX_LENGTH } from "@kept/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { updatePage } from "@/lib/sites/owner-client";
import { cn } from "@/lib/utils";

import { Section } from "./section";

/** How long "Saved." stays before the bar folds away (the design's 1.8 s). */
const SAVED_MS = 1800;

/** PRD §5.2 / AC37, verbatim — until E15 opens Explore. */
const EXPLORE_LABEL = "List on Explore when it opens";

interface DetailsValues {
  title: string;
  listed: boolean;
}

type Phase =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

export function DetailsSection({
  siteId,
  title,
  fallbackName,
  listedPublic,
  canEditTitle,
  canList,
  listingNote,
}: {
  siteId: string;
  /** The stored title (the page's own or the owner's); `null` → none. */
  title: string | null;
  /** What the page is called without a title — its name — as the placeholder. */
  fallbackName: string;
  listedPublic: boolean;
  /** PRD §5.2: live (kept or draft) and under review. Otherwise the field is absent. */
  canEditTitle: boolean;
  /** Kept and live. Otherwise the toggle is DISABLED with `listingNote` — the one exception to "absent". */
  canList: boolean;
  listingNote: string;
}) {
  const router = useRouter();
  const fromProps: DetailsValues = { title: title ?? "", listed: listedPublic };
  const [baseline, setBaseline] = useState(fromProps);
  const [values, setValues] = useState(fromProps);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const titleId = useId();
  const titleNoteId = useId();
  const listId = useId();
  const listNoteId = useId();

  const dirty = values.title !== baseline.title || values.listed !== baseline.listed;

  // Adopt a new server render while clean — React's "adjust state on a prop
  // change" pattern, so no effect paints the stale value first.
  const propsKey = `${fromProps.title}\u0000${fromProps.listed}`;
  const [seenKey, setSeenKey] = useState(propsKey);
  if (propsKey !== seenKey) {
    setSeenKey(propsKey);
    if (!dirty && phase.kind !== "saving") {
      setBaseline(fromProps);
      setValues(fromProps);
    }
  }

  useEffect(() => {
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
      abort.current?.abort();
    };
  }, []);

  function edit(next: Partial<DetailsValues>) {
    setValues((current) => ({ ...current, ...next }));
    if (phase.kind !== "saving") setPhase({ kind: "idle" });
  }

  function discard() {
    setValues(baseline);
    setPhase({ kind: "idle" });
  }

  async function save() {
    if (!dirty || phase.kind === "saving") return;
    if (savedTimer.current) clearTimeout(savedTimer.current);
    setPhase({ kind: "saving" });

    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const outcome = await updatePage(
      siteId,
      {
        ...(values.title !== baseline.title ? { title: values.title } : {}),
        ...(values.listed !== baseline.listed ? { listedPublic: values.listed } : {}),
      },
      controller.signal,
    );
    if (controller.signal.aborted) return;

    if (!outcome.ok) {
      setPhase({ kind: "error", message: outcome.error.message });
      return;
    }
    const saved = { title: outcome.site.title ?? "", listed: outcome.site.listedPublic };
    setBaseline(saved);
    setValues(saved);
    setPhase({ kind: "saved" });
    savedTimer.current = setTimeout(() => setPhase({ kind: "idle" }), SAVED_MS);
    router.refresh();
  }

  const showBar = dirty || phase.kind !== "idle";

  return (
    <Section title="Details" testId="details-section">
      {canEditTitle ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={titleId} className="text-sm font-medium text-text">
            Title
          </label>
          <Input
            id={titleId}
            data-testid="title-input"
            value={values.title}
            maxLength={PAGE_TITLE_MAX_LENGTH}
            placeholder={fallbackName}
            autoComplete="off"
            aria-describedby={titleNoteId}
            aria-invalid={phase.kind === "error" ? true : undefined}
            disabled={phase.kind === "saving"}
            onChange={(event) => edit({ title: event.target.value })}
            className="h-11 rounded-[var(--r-sm)] text-[15px] shadow-none"
          />
          <p id={titleNoteId} className="text-[13px] text-text-secondary">
            Leave it empty to use the page&rsquo;s own title.
          </p>
        </div>
      ) : null}

      <div className={cn("flex items-center gap-3", canEditTitle && "border-t border-border pt-3")}>
        <span className="flex min-w-0 flex-1 flex-col leading-[1.35]">
          <label htmlFor={listId} className="text-[15px] text-text">
            {EXPLORE_LABEL}
          </label>
          <span id={listNoteId} className="text-[13px] text-pretty text-text-secondary">
            {listingNote}
          </span>
        </span>
        <Switch
          id={listId}
          data-testid="explore-toggle"
          checked={values.listed}
          disabled={!canList || phase.kind === "saving"}
          aria-describedby={listNoteId}
          onCheckedChange={(listed) => edit({ listed })}
          className="data-[state=unchecked]:bg-text-muted"
        />
      </div>

      {showBar ? (
        <div
          data-testid="save-bar"
          data-phase={phase.kind === "idle" ? (dirty ? "dirty" : "clean") : phase.kind}
          className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-3"
        >
          <span
            role={phase.kind === "error" ? "alert" : "status"}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 text-sm",
              phase.kind === "error" ? "text-danger" : "text-text",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                phase.kind === "saved" ? "bg-live" : phase.kind === "error" ? "bg-danger" : "bg-text-muted",
              )}
            />
            {phase.kind === "saving"
              ? "Saving…"
              : phase.kind === "saved"
                ? "Saved."
                : phase.kind === "error"
                  ? phase.message
                  : "Unsaved changes"}
          </span>
          {dirty ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={phase.kind === "saving"}
                onClick={discard}
                className="font-body font-medium"
              >
                Discard
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid="details-save"
                disabled={phase.kind === "saving"}
                onClick={save}
                className="font-body font-medium"
              >
                Save
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
